import { afterEach, describe, expect, it, vi } from "vitest";
import { TeleTopazService } from "../src/bot.js";
import { quotaService } from "../src/services/quota.js";
import type { TelegramApi } from "../src/telegram/api.js";
import type { TelegramMessage } from "../src/telegram/types.js";

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

describe("TeleTopazService auto mode session bootstrap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not create a concrete provider session during startup before auto routing picks a model", async () => {
    const service = new TeleTopazService(createApi(), "1", "1", 0);
    const createSession = vi.fn().mockResolvedValue(undefined);
    const processOnSpy = vi.spyOn(process, "on").mockReturnValue(process);
    const state = (service as unknown as {
      getOrCreateState: (chatId: number) => Record<string, unknown>;
      createSession: typeof createSession;
    }).getOrCreateState(1);

    state.mode = "auto";
    state.model = undefined;

    (service as unknown as { getModels: () => Promise<string[]> }).getModels = vi.fn().mockResolvedValue(["gpt-5.4"]);
    (service as unknown as { loadAllowedDirectories: () => Promise<string[]> }).loadAllowedDirectories = vi
      .fn()
      .mockResolvedValue(["/tmp/TempNote"]);
    (service as unknown as { ensureTempNoteDirectory: () => Promise<void> }).ensureTempNoteDirectory = vi.fn().mockResolvedValue(undefined);
    (service as unknown as { clearOfflineUpdates: () => Promise<void> }).clearOfflineUpdates = vi.fn().mockResolvedValue(undefined);
    (service as unknown as { fetchProviderInfo: () => Promise<string | undefined> }).fetchProviderInfo = vi.fn().mockResolvedValue(undefined);
    (service as unknown as { sendWelcome: () => Promise<void> }).sendWelcome = vi.fn().mockResolvedValue(undefined);
    (service as unknown as { createSession: typeof createSession }).createSession = createSession;
    (service as unknown as { poll: () => Promise<void> }).poll = vi.fn().mockResolvedValue(undefined);

    try {
      await service.start();
    } finally {
      processOnSpy.mockRestore();
    }

    expect(createSession).not.toHaveBeenCalled();
    expect(state.workDir).toBe("/tmp/TempNote");
    expect(state.model).toBeUndefined();
  });

  it("switches project in auto mode without creating a concrete session before routing", async () => {
    const service = new TeleTopazService(createApi(), "1", "1", 0);
    const createSession = vi.fn().mockResolvedValue(undefined);
    const state = (service as unknown as {
      getOrCreateState: (chatId: number) => Record<string, unknown>;
      createSession: typeof createSession;
    }).getOrCreateState(1);

    state.mode = "auto";
    state.model = undefined;
    state.cachedDirs = ["/tmp/TempNote"];
    (service as unknown as { createSession: typeof createSession }).createSession = createSession;

    await (service as unknown as {
      setDirectory: (chatId: number, index: number) => Promise<void>;
    }).setDirectory(1, 0);

    expect(createSession).not.toHaveBeenCalled();
    expect(state.workDir).toBe("/tmp/TempNote");
  });

  it("routes the first message after project selection in auto mode", async () => {
    const service = new TeleTopazService(createApi(), "1", "1", 0);
    const safeSend = vi.fn().mockResolvedValue({ message_id: 99 });
    const createSession = vi.fn().mockResolvedValue(undefined);
    const sendPrompt = vi.fn().mockResolvedValue({ chunked: false, totalChunks: 1 });
    const classifyIntent = vi.fn().mockResolvedValue("ROUTER");
    const state = (service as unknown as {
      getOrCreateState: (chatId: number) => Record<string, unknown>;
      safeSend: typeof safeSend;
      createSession: typeof createSession;
      sendPrompt: typeof sendPrompt;
      classifyIntent: typeof classifyIntent;
      guardrailsPromise: Promise<unknown>;
    }).getOrCreateState(1);

    state.mode = "auto";
    state.model = undefined;
    state.cachedDirs = ["/tmp/TempNote"];
    (service as unknown as { safeSend: typeof safeSend }).safeSend = safeSend;
    (service as unknown as { createSession: typeof createSession }).createSession = createSession;
    (service as unknown as { sendPrompt: typeof sendPrompt }).sendPrompt = sendPrompt;
    (service as unknown as { classifyIntent: typeof classifyIntent }).classifyIntent = classifyIntent;
    (service as unknown as { guardrailsPromise: Promise<unknown> }).guardrailsPromise = Promise.resolve({
      version: 1,
      maxPromptLength: 4000,
      denyRules: [],
      allowRules: []
    });
    vi.spyOn(quotaService, "increment").mockResolvedValue(undefined);

    await (service as unknown as {
      setDirectory: (chatId: number, index: number) => Promise<void>;
    }).setDirectory(1, 0);
    safeSend.mockClear();

    const message: TelegramMessage = {
      message_id: 5,
      date: 1,
      chat: { id: 1, type: "private" },
      from: { id: 1, is_bot: false, first_name: "Owner" },
      text: "hello"
    };

    await (service as unknown as {
      handleMessage: (message: TelegramMessage) => Promise<void>;
    }).handleMessage(message);

    expect(classifyIntent).toHaveBeenCalledWith(1, "hello", state.routerModel);
    expect(createSession).toHaveBeenCalledWith(1, "/tmp/TempNote", state.routerModel);
    expect(sendPrompt).toHaveBeenCalledOnce();
    expect(safeSend.mock.calls.map((call) => call[1])).not.toContain("請先使用 /project 選擇工作區。");
  });
});
