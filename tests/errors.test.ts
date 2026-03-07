import { describe, it, expect } from "vitest";
import {
  consumeRepeatedLog,
  extractNetworkErrorSummary,
  isConnectionDisposedError,
  isTransientTelegramNetworkError
} from "../src/util/errors.js";

describe("errors", () => {
  it("detects connection disposed", () => {
    expect(isConnectionDisposedError({ code: -32097 })).toBe(true);
    expect(isConnectionDisposedError({ message: "connection got disposed" })).toBe(true);
  });

  it("extracts transient Telegram network summaries from nested errors", () => {
    const error = Object.assign(new Error("request failed"), {
      cause: {
        code: "ETIMEDOUT",
        address: "api.telegram.org",
        port: 443,
        message: "connect ETIMEDOUT api.telegram.org:443"
      }
    });

    expect(extractNetworkErrorSummary(error)).toBe("ETIMEDOUT | api.telegram.org:443 | connect ETIMEDOUT api.telegram.org:443");
    expect(isTransientTelegramNetworkError(error)).toBe(true);
  });

  it("suppresses repeated log entries inside the dedupe window", () => {
    const state = { suppressedCount: 0 };

    expect(consumeRepeatedLog(state, "ETIMEDOUT", 1_000, 15_000)).toEqual({
      shouldLog: true,
      suppressedCount: 0
    });
    expect(consumeRepeatedLog(state, "ETIMEDOUT", 2_000, 15_000)).toEqual({
      shouldLog: false,
      suppressedCount: 0
    });
    expect(consumeRepeatedLog(state, "ETIMEDOUT", 20_000, 15_000)).toEqual({
      shouldLog: true,
      suppressedCount: 1
    });
  });
});
