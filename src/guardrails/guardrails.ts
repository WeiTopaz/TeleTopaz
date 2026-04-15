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
  "ssh key",       // v3: ssh → ssh key（避免封鎖 "show ssh connection status"）
  "keychain",
  "env",
  "environment variable",
  "credential",
  "cookie",
  "session",
  // v5 移除："/etc/passwd", "/etc/shadow"（\b 不相容路徑；builtin 已涵蓋）
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

// 偵測字串是否包含 CJK 字元（中日韓）
const CJK_RANGE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 智慧分句：
 * - 明確句號：! ? 。 ！ ？ \n 直接切
 * - 英文句號 .：只在後接「空白+字母（[A-Za-z]）」或中文字元時才切
 *   避免切割 config.json、v18.0.1、api.example.com
 *
 * v8 修正：evaluateSemantic 呼叫 normalizeText() 後再傳入（全小寫），
 * 原 [A-Z] 永遠不匹配，改為 [A-Za-z]。
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[!?。！？\n])\s*|(?<=\.)\s+(?=[A-Za-z\u4e00-\u9fff])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 判斷 word 是否出現在 text 中。
 * - 英文：\b 詞邊界 + s? 複數容許
 * - 中文：直接 includes()
 * - 多詞短語（如 "api key"）：\b 包裹整體，中間空格自然匹配
 */
function matchesWord(text: string, word: string): boolean {
  if (!word) return false;
  if (CJK_RANGE.test(word)) {
    return text.includes(word);
  }
  try {
    return new RegExp(`\\b${escapeRegex(word)}s?\\b`, "i").test(text);
  } catch {
    return text.includes(word);
  }
}

/**
 * 安全語境表：target 出現在已知開發短語中時，豁免該 target 的封鎖。
 * v5：移除 "env file"（攻擊繞過風險），新增 "env.example"、"env template"
 * v6：移除 "env variable"，改為 "env variable type/syntax/docs"；
 *      新增 "environment variable" 的安全語境
 */
const SAFE_TARGET_CONTEXTS: Record<string, readonly string[]> = {
  "token":                ["token count", "token limit", "token usage", "token type", "token bucket", "token refresh", "csrf token", "token string"],
  "session":              ["session middleware", "session timeout", "session storage", "session management", "session config", "session handler", "session pool"],
  "env":                  ["env config", "env setup", "env example", "env.example", "env template",
                           "env variable type", "env variable syntax", "env variable docs"],
  "environment variable": ["environment variable type", "environment variable syntax",
                           "environment variable config", "environment variable docs"],
  "credential":           ["credential flow", "credential provider", "credential rotation", "credential store"],
  "cookie":               ["cookie policy", "cookie banner", "cookie consent", "cookie parser", "cookie jar"],
  "secret":               ["secret manager", "secret rotation", "secret store", "secret backend"],
  "ssh key":              ["ssh key generation", "ssh key format", "ssh key pair"],
};

/**
 * 檢查 target 是否出現在安全語境中。
 * v7 修正：先將句中 target 複數形正規化為單數（鏡像 matchesWord 的 s? 行為），
 * 使 "show tokens count" 能正確匹配 "token count" 安全語境。
 */
function isInSafeContext(sentence: string, target: string): boolean {
  const contexts = SAFE_TARGET_CONTEXTS[target];
  if (!contexts) return false;
  const pluralTarget = escapeRegex(target) + "s";
  const normalized = sentence.replace(new RegExp(`\\b${pluralTarget}\\b`, "i"), target);
  return contexts.some((safe) => normalized.includes(safe));
}

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

  // Phase 2: action×target — 詞邊界 + 同句鄰近度 + 安全語境排除
  const sentences = splitSentences(lower);
  for (const sentence of sentences) {
    const hasAction = SEMANTIC_ACTIONS.some((a) => matchesWord(sentence, a));
    if (!hasAction) continue;

    for (const target of SEMANTIC_TARGETS) {
      if (!matchesWord(sentence, target)) continue;
      if (isInSafeContext(sentence, target)) continue;
      return {
        allowed: false,
        source: "semantic",
        ruleId: "semantic_sensitive_request",
        reason: "偵測到請求敏感資訊的意圖"
      };
    }
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
