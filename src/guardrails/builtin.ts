import { GuardrailRule } from "./types.js";

const PRIVATE_KEY_RULE: GuardrailRule = {
  id: "builtin_private_key",
  description: "Detect PEM private key blocks",
  regex: ["-----BEGIN ([A-Z ]+?)-----[\\s\\S]*?-----END \\1-----"]
};

const KNOWN_TOKEN_RULE: GuardrailRule = {
  id: "builtin_token_patterns",
  description: "Detect common API token patterns",
  regex: [
    "\\bsk-[A-Za-z0-9]{16,}\\b",
    "\\bgh[opsru]_[A-Za-z0-9]{20,}\\b",
    "\\bghs_[A-Za-z0-9]{20,}\\b",
    "\\b\\d{6,}:[A-Za-z0-9_-]{20,}\\b"
  ]
};

const PROMPT_INJECTION_RULE: GuardrailRule = {
  id: "builtin_prompt_injection",
  description: "Detect attempts to override system instructions",
  contains: [
    "ignore previous instructions",
    "ignore above instructions",
    "override system",
    "disregard system",
    "jailbreak",
    "忽略前述指示",
    "忽略之前的指示",
    "覆寫系統",
    "無視系統"
  ]
};

const SECRET_LEAK_RULE: GuardrailRule = {
  id: "builtin_secret_leak",
  description: "Detect requests to reveal secrets",
  contains: [
    "show password",
    "reveal password",
    "show secret",
    "reveal secret",
    "show token",
    "reveal token",
    "顯示密碼",
    "洩漏密碼",
    "顯示令牌",
    "洩漏令牌",
    "顯示金鑰",
    "洩漏金鑰"
  ]
};

const SENSITIVE_PATH_RULE: GuardrailRule = {
  id: "builtin_sensitive_paths",
  description: "Detect access to sensitive system paths",
  contains: [
    "/etc/passwd",
    "/etc/shadow",
    ".ssh/",
    ".aws/",
    ".gnupg/",
    "id_rsa"
  ]
};

export const BUILTIN_RULES: GuardrailRule[] = [
  PRIVATE_KEY_RULE,
  KNOWN_TOKEN_RULE,
  PROMPT_INJECTION_RULE,
  SECRET_LEAK_RULE,
  SENSITIVE_PATH_RULE
];
