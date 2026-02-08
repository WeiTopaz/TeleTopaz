import { promises as fs } from "node:fs";
import path from "node:path";
import { BUILTIN_RULES } from "./builtin.js";
import { GuardrailDecision, GuardrailPolicy, GuardrailRule } from "./types.js";
import { getRedactionPlaceholder, redactStrict } from "../util/redaction.js";

const DEFAULT_POLICY: GuardrailPolicy = {
  version: 1,
  maxPromptLength: 4096,
  denyRules: [],
  allowRules: []
};

export async function loadGuardrails(): Promise<GuardrailPolicy> {
  const candidates = [
    path.join(process.cwd(), "guardrails.json"),
    path.join(path.dirname(process.argv[1] ?? ""), "guardrails.json")
  ];

  for (const file of candidates) {
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw) as GuardrailPolicy;
      if (typeof parsed.version !== "number") {
        continue;
      }
      return {
        version: parsed.version,
        maxPromptLength: parsed.maxPromptLength ?? DEFAULT_POLICY.maxPromptLength ?? 4000,
        denyRules: Array.isArray(parsed.denyRules) ? parsed.denyRules : [],
        allowRules: Array.isArray(parsed.allowRules) ? parsed.allowRules : []
      };
    } catch {
      continue;
    }
  }
  return { ...DEFAULT_POLICY };
}

function normalizeText(input: string): string {
  return input.toLowerCase();
}

const SEMANTIC_BYPASS_PHRASES = [
  "ignore safety",
  "ignore guardrails",
  "disable guardrails",
  "bypass guardrails",
  "bypass security",
  "no restrictions",
  "忽略安全",
  "忽略護欄",
  "關閉護欄",
  "繞過護欄",
  "繞過安全",
  "無限制"
];

const SEMANTIC_ACTIONS = [
  "show",
  "reveal",
  "display",
  "dump",
  "export",
  "print",
  "leak",
  "exfiltrate",
  "steal",
  "read",
  "cat",
  "顯示",
  "揭露",
  "輸出",
  "列出",
  "洩漏",
  "讀取",
  "匯出"
];

const SEMANTIC_TARGETS = [
  "password",
  "secret",
  "token",
  "api key",
  "apikey",
  "private key",
  "ssh",
  "keychain",
  "env",
  "environment variable",
  "credential",
  "cookie",
  "session",
  "/etc/passwd",
  "/etc/shadow",
  "密碼",
  "金鑰",
  "密鑰",
  "令牌",
  "私鑰",
  "憑證",
  "環境變數",
  "金鑰圈",
  "憑據"
];

function ruleMatches(rule: GuardrailRule, text: string): boolean {
  const lower = normalizeText(text);
  if (rule.contains) {
    for (const needle of rule.contains) {
      if (!needle) continue;
      if (lower.includes(needle.toLowerCase())) return true;
    }
  }
  if (rule.regex) {
    for (const pattern of rule.regex) {
      if (!pattern) continue;
      try {
        const re = new RegExp(pattern, "i");
        if (re.test(text)) return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}

function evaluateSemantic(prompt: string): GuardrailDecision | undefined {
  const lower = normalizeText(prompt);
  for (const phrase of SEMANTIC_BYPASS_PHRASES) {
    if (phrase && lower.includes(phrase)) {
      return {
        allowed: false,
        source: "semantic",
        ruleId: "semantic_bypass",
        reason: "偵測到繞過安全護欄的意圖"
      };
    }
  }

  const hasAction = SEMANTIC_ACTIONS.some((action) => action && lower.includes(action));
  const hasTarget = SEMANTIC_TARGETS.some((target) => target && lower.includes(target));
  if (hasAction && hasTarget) {
    return {
      allowed: false,
      source: "semantic",
      ruleId: "semantic_sensitive_request",
      reason: "偵測到請求敏感資訊的意圖"
    };
  }

  return undefined;
}

export function evaluatePromptWithOptions(
  policy: GuardrailPolicy,
  prompt: string,
  options?: { ignoreLength?: boolean; skipSemantic?: boolean }
): GuardrailDecision {
  const text = prompt ?? "";
  const maxLen = policy.maxPromptLength ?? DEFAULT_POLICY.maxPromptLength ?? 4000;
  if (!options?.ignoreLength && text.length > maxLen) {
    return {
      allowed: false,
      source: "length",
      reason: `提示詞長度超過上限 (${maxLen})`
    };
  }

  for (const rule of BUILTIN_RULES) {
    if (ruleMatches(rule, text)) {
      const decision: GuardrailDecision = {
        allowed: false,
        ruleId: rule.id,
        source: "builtin"
      };
      if (rule.description) decision.reason = rule.description;
      return decision;
    }
  }

  if (!options?.skipSemantic) {
    const semantic = evaluateSemantic(text);
    if (semantic) return semantic;
  }

  for (const rule of policy.denyRules ?? []) {
    if (ruleMatches(rule, text)) {
      const decision: GuardrailDecision = {
        allowed: false,
        ruleId: rule.id,
        source: "deny"
      };
      if (rule.description) decision.reason = rule.description;
      return decision;
    }
  }

  for (const rule of policy.allowRules ?? []) {
    if (ruleMatches(rule, text)) {
      const decision: GuardrailDecision = {
        allowed: true,
        ruleId: rule.id,
        source: "allow"
      };
      if (rule.description) decision.reason = rule.description;
      return decision;
    }
  }

  return { allowed: true, source: "default" };
}

export function evaluatePrompt(policy: GuardrailPolicy, prompt: string): GuardrailDecision {
  return evaluatePromptWithOptions(policy, prompt);
}

export function evaluatePromptIgnoringLength(policy: GuardrailPolicy, prompt: string): GuardrailDecision {
  return evaluatePromptWithOptions(policy, prompt, { ignoreLength: true });
}

export type GuardedOutput = {
  decision: GuardrailDecision;
  blocked: boolean;
  text: string;
};

export function guardToolOutput(policy: GuardrailPolicy, output: string): GuardedOutput {
  const decision = evaluatePromptWithOptions(policy, output, { ignoreLength: true, skipSemantic: true });
  if (!decision.allowed) {
    const reason = decision.reason ?? "工具輸出觸發安全規則";
    const tag = decision.ruleId ?? decision.source;
    return {
      decision,
      blocked: true,
      text: `${getRedactionPlaceholder()} ${reason} (${tag})`
    };
  }

  return {
    decision,
    blocked: false,
    text: redactStrict(output)
  };
}
