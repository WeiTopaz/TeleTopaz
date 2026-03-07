import { describe, expect, it, vi } from "vitest";
import { TeleTopazService } from "../src/bot.js";
import type { TelegramApi } from "../src/telegram/api.js";
import { logger } from "../src/util/logger.js";

function createApi(sendMessageError: Error): TelegramApi {
  return {
    sendMessage: vi.fn().mockRejectedValue(sendMessageError),
    editMessageText: vi.fn().mockResolvedValue({}),
    editMessageTextPlain: vi.fn().mockResolvedValue({}),
    getChat: vi.fn().mockRejectedValue(new Error("chat unavailable")),
    setMessageReaction: vi.fn(),
    getUpdates: vi.fn(),
    getFile: vi.fn(),
    getFileContent: vi.fn(),
    answerCallbackQuery: vi.fn()
  } as unknown as TelegramApi;
}

describe("TeleTopazService welcome error propagation", () => {
  it("logs welcome failure instead of success when startup message cannot be delivered", async () => {
    const api = createApi(new Error("Bad Request: chat not found"));
    const service = new TeleTopazService(api, "6494154303", "1", 0);
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const processOnSpy = vi.spyOn(process, "on").mockReturnValue(process);

    (service as unknown as { getModels: () => Promise<string[]> }).getModels = vi.fn().mockResolvedValue(["gpt-5.4"]);
    (service as unknown as { loadAllowedDirectories: () => Promise<string[]> }).loadAllowedDirectories = vi
      .fn()
      .mockResolvedValue(["/tmp/TempNote"]);
    (service as unknown as { ensureTempNoteDirectory: () => Promise<void> }).ensureTempNoteDirectory = vi.fn().mockResolvedValue(undefined);
    (service as unknown as { clearOfflineUpdates: () => Promise<void> }).clearOfflineUpdates = vi.fn().mockResolvedValue(undefined);
    (service as unknown as { fetchProviderInfo: () => Promise<string | undefined> }).fetchProviderInfo = vi.fn().mockResolvedValue(undefined);
    (service as unknown as { createSession: () => Promise<void> }).createSession = vi.fn().mockResolvedValue(undefined);
    (service as unknown as { poll: () => Promise<void> }).poll = vi.fn().mockResolvedValue(undefined);

    try {
      await service.start();

      const successLogged = infoSpy.mock.calls.some(([message]) => message === "Welcome message and provider info sent to owner");
      const welcomeFailureLogged = errorSpy.mock.calls.some(([message]) => message === "Welcome send failed");

      expect(successLogged).toBe(false);
      expect(welcomeFailureLogged).toBe(true);
    } finally {
      infoSpy.mockRestore();
      errorSpy.mockRestore();
      processOnSpy.mockRestore();
    }
  });
});
