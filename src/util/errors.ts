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
