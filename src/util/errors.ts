export function isConnectionDisposedError(error: unknown): boolean {
  if (!error) return false;
  const anyErr = error as { code?: number | string; message?: string };
  if (anyErr.code === "ERR_STREAM_DESTROYED") return true;
  if (anyErr.code === -32097 || anyErr.code === "-32097") return true;
  const message = anyErr.message ?? "";
  return (
    message.includes("pending response rejected since connection got disposed") ||
    message.includes("connection got disposed") ||
    message.includes("ERR_STREAM_DESTROYED") ||
    message.includes("Cannot call write after a stream was destroyed")
  );
}

export function isTelegramReactionInvalid(error: unknown): boolean {
  if (!error) return false;
  const anyErr = error as { message?: string };
  const message = anyErr.message ?? "";
  return message.includes("REACTION_INVALID");
}

const TRANSIENT_NETWORK_CODES = new Set([
  "ETIMEDOUT",
  "ENETUNREACH",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNRESET"
]);

export function extractNetworkErrorSummary(error: unknown): string | undefined {
  const visited = new Set<unknown>();
  const queue: unknown[] = [error];
  let fallbackCode: string | undefined;
  let fallbackSummary: string | undefined;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || visited.has(current)) {
      continue;
    }

    visited.add(current);
    const record = current as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code : undefined;
    const address = typeof record.address === "string" ? record.address : undefined;
    const port = typeof record.port === "number" ? record.port : undefined;
    const message = typeof record.message === "string" ? record.message : undefined;

    if (code && TRANSIENT_NETWORK_CODES.has(code)) {
      const target = address ? `${address}${port ? `:${port}` : ""}` : "";
      const summary = [code, target, message].filter((item) => item && item.length > 0).join(" | ");
      if (target) {
        return summary;
      }
      if (!fallbackSummary && message && message.length > 0) {
        fallbackSummary = summary;
      }
      if (!fallbackCode) {
        fallbackCode = code;
      }
    }

    if (record.cause) queue.push(record.cause);
    if (record.error) queue.push(record.error);
    if (Array.isArray(record.errors)) queue.push(...record.errors);
  }

  return fallbackSummary ?? fallbackCode;
}

export function isTransientTelegramNetworkError(error: unknown): boolean {
  const summary = extractNetworkErrorSummary(error);
  if (!summary) return false;
  return /ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|ENOTFOUND/.test(summary);
}

export type RepeatedLogState = {
  lastKey?: string;
  lastAtMs?: number;
  suppressedCount: number;
};

export function consumeRepeatedLog(
  state: RepeatedLogState,
  key: string,
  nowMs: number,
  windowMs: number
): { shouldLog: boolean; suppressedCount: number } {
  const inWindow =
    state.lastKey === key &&
    typeof state.lastAtMs === "number" &&
    nowMs - state.lastAtMs < windowMs;

  if (inWindow) {
    state.suppressedCount += 1;
    return { shouldLog: false, suppressedCount: 0 };
  }

  const suppressedCount = state.lastKey === key ? state.suppressedCount : 0;
  state.lastKey = key;
  state.lastAtMs = nowMs;
  state.suppressedCount = 0;
  return { shouldLog: true, suppressedCount };
}
