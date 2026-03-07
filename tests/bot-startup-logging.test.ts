import { describe, expect, it, vi } from "vitest";
import { TeleTopazService } from "../src/bot.js";
import { logger } from "../src/util/logger.js";
import type { TelegramApi } from "../src/telegram/api.js";

function createApi(): TelegramApi {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    editMessageText: vi.fn().mockResolvedValue({}),
    editMessageTextPlain: vi.fn().mockResolvedValue({}),
    getChat: vi.fn(),
    setMessageReaction: vi.fn(),
    getUpdates: vi.fn(),
    getFile: vi.fn(),
    getFileContent: vi.fn(),
    answerCallbackQuery: vi.fn()
  } as unknown as TelegramApi;
}

describe("TeleTopazService startup logging", () => {
  it("does not log full allowed directories or owner chat id during startup", async () => {
    const service = new TeleTopazService(createApi(), "6494154303", "1", 0);
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    const processOnSpy = vi.spyOn(process, "on").mockReturnValue(process);

    (service as unknown as { getModels: () => Promise<string[]> }).getModels = vi.fn().mockResolvedValue(["gpt-5.4"]);
    (service as unknown as { loadAllowedDirectories: () => Promise<string[]> }).loadAllowedDirectories = vi
      .fn()
      .mockResolvedValue(["/Users/test/Project/Alpha", "/Users/test/Project/Beta"]);
    (service as unknown as { ensureTempNoteDirectory: () => Promise<void> }).ensureTempNoteDirectory = vi.fn().mockResolvedValue(undefined);
    (service as unknown as { clearOfflineUpdates: () => Promise<void> }).clearOfflineUpdates = vi.fn().mockResolvedValue(undefined);
    (service as unknown as { fetchProviderInfo: () => Promise<string | undefined> }).fetchProviderInfo = vi.fn().mockResolvedValue(undefined);
    (service as unknown as { sendWelcome: () => Promise<void> }).sendWelcome = vi.fn().mockResolvedValue(undefined);
    (service as unknown as { createSession: () => Promise<void> }).createSession = vi.fn().mockResolvedValue(undefined);
    (service as unknown as { poll: () => Promise<void> }).poll = vi.fn().mockResolvedValue(undefined);

    try {
      await service.start();

      const joinedLogs = infoSpy.mock.calls
        .map((args) => args.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "))
        .join("\n");

      expect(joinedLogs).not.toContain("/Users/test/Project/Alpha");
      expect(joinedLogs).not.toContain("/Users/test/Project/Beta");
      expect(joinedLogs).not.toContain("6494154303");
    } finally {
      infoSpy.mockRestore();
      processOnSpy.mockRestore();
    }
  });
});
