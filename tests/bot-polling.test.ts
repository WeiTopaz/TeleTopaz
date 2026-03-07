import { afterEach, describe, expect, it, vi } from "vitest";
import { TeleTopazService } from "../src/bot.js";
import type { TelegramApi } from "../src/telegram/api.js";

function createApi(): TelegramApi {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    editMessageText: vi.fn().mockResolvedValue({}),
    editMessageTextPlain: vi.fn().mockResolvedValue({}),
    getChat: vi.fn().mockResolvedValue({ id: 1, first_name: "Owner" }),
    setMessageReaction: vi.fn(),
    getUpdates: vi.fn(),
    getFile: vi.fn(),
    getFileContent: vi.fn(),
    answerCallbackQuery: vi.fn()
  } as unknown as TelegramApi;
}

describe("TeleTopazService polling", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("deduplicates repeated transient polling errors and logs a network summary", async () => {
    vi.useFakeTimers();

    const api = createApi();
    const service = new TeleTopazService(api, "1", "1", 0);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const transientError = new Error("connect ETIMEDOUT");
    Object.assign(transientError, {
      code: "ETIMEDOUT",
      cause: {
        code: "ETIMEDOUT",
        address: "api.telegram.org",
        port: 443,
        message: "connect ETIMEDOUT api.telegram.org:443"
      }
    });

    let attempts = 0;
    vi.mocked(api.getUpdates).mockImplementation(async () => {
      attempts += 1;
      if (attempts >= 2) {
        (service as unknown as { running: boolean }).running = false;
      }
      throw transientError;
    });

    const pollPromise = (service as unknown as {
      running: boolean;
      poll: () => Promise<void>;
    }).poll();

    await vi.advanceTimersByTimeAsync(2_500);
    await pollPromise;

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = warnSpy.mock.calls.map((call) => call.slice(1).join(" ")).join("\n");
    expect(logged).toContain("ETIMEDOUT");
    expect(logged).toContain("api.telegram.org:443");
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
