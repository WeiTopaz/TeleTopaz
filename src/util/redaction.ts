const REDACTION = "[REDACTED]";

const PEM_BLOCK = /-----BEGIN ([A-Z ]+?)-----[\s\S]*?-----END \1-----/g;
const ENV_ASSIGNMENT = /\b([A-Z][A-Z0-9_]*?(?:_TOKEN|_KEY|_SECRET|_PASSWORD))\s*=\s*[^\s]+/g;
const OPENAI_TOKEN = /\bsk-[A-Za-z0-9]{16,}\b/g;
const TELEGRAM_BOT_TOKEN = /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g;
const GITHUB_TOKEN = /\bgh[opsru]_[A-Za-z0-9]{20,}\b/g;
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;
const JWT = /\beyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g;
const SLACK_TOKEN = /\bxox[baprs]-[A-Za-z0-9-]+\b/g;
const GITLAB_TOKEN = /\bglpat-[A-Za-z0-9_-]{20,}\b/g;
const GOOGLE_API_KEY = /\bAIza[0-9A-Za-z-_]{35}\b/g;
const STRIPE_SECRET = /\bsk_live_[0-9a-zA-Z]{10,}\b/g;
const STRIPE_RESTRICTED = /\brk_live_[0-9a-zA-Z]{10,}\b/g;

const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._-]+\b/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /\b(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{2,4}\)?[-.\s]?)\d{3,4}[-.\s]?\d{3,4}\b/g;

const BASE_PATTERNS = [
  PEM_BLOCK,
  ENV_ASSIGNMENT,
  OPENAI_TOKEN,
  TELEGRAM_BOT_TOKEN,
  GITHUB_TOKEN,
  AWS_ACCESS_KEY,
  JWT,
  SLACK_TOKEN,
  GITLAB_TOKEN,
  GOOGLE_API_KEY,
  STRIPE_SECRET,
  STRIPE_RESTRICTED
];

const STRICT_PATTERNS = [
  BEARER_TOKEN,
  EMAIL,
  PHONE
];

export function redact(input: string): string {
  let output = input;
  for (const pattern of BASE_PATTERNS) {
    output = output.replace(pattern, REDACTION);
  }
  return output;
}

export function redactStrict(input: string): string {
  let output = input;
  for (const pattern of BASE_PATTERNS) {
    output = output.replace(pattern, REDACTION);
  }
  for (const pattern of STRICT_PATTERNS) {
    output = output.replace(pattern, REDACTION);
  }
  return output;
}

export function redactUnknown(input: unknown): unknown {
  if (typeof input === "string") {
    return redact(input);
  }
  if (input instanceof Error) {
    const message = redact(input.message);
    const stack = input.stack ? redact(input.stack) : undefined;
    const clone = new Error(message);
    if (stack) clone.stack = stack;
    return clone;
  }
  return input;
}

export function redactObject(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      output[key] = redact(value);
    } else if (value instanceof Error) {
      output[key] = redactUnknown(value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

export function getRedactionPlaceholder(): string {
  return REDACTION;
}
