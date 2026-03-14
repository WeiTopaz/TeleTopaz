import { afterEach, describe, expect, it, vi } from "vitest";
import { TeleTopazService } from "../src/bot.js";
import { quotaService } from "../src/services/quota.js";
import type { AiSession } from "../src/provider/types.js";
import type { TelegramApi } from "../src/telegram/api.js";
import type { InlineKeyboardMarkup, TelegramCallbackQuery, TelegramMessage } from "../src/telegram/types.js";

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
    answerCallbackQuery: vi.fn().mockResolvedValue(true)
  } as unknown as TelegramApi;
}

function createSession(overrides: Partial<AiSession> = {}): AiSession {
  return {
    onEvent: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    sendAndWait: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

function createMessage(text: string): TelegramMessage {
  return {
    message_id: 5,
    date: 1,
    chat: { id: 1, type: "private" },
    from: { id: 1, is_bot: false, first_name: "Owner" },
    text
  };
}

function createCallback(data: string): TelegramCallbackQuery {
  return {
    id: "cb-1",
    from: { id: 1, is_bot: false, first_name: "Owner" },
    message: {
      message_id: 9,
      date: 1,
      chat: { id: 1, type: "private" }
    },
    data
  };
}

describe("TeleTopazService session resilience", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rebuilds a disposed session and asks before resending the original prompt", async () => {
    const api = createApi();
    const service = new TeleTopazService(api, "1", "1", 0);
    const state = (service as unknown as {
      getOrCreateState: (chatId: number) => Record<string, unknown>;
    }).getOrCreateState(1);

    const replacementSession = createSession();
    state.workDir = "/tmp/project";
    state.provider = "copilot";
    state.mode = "manual";
    state.model = "gpt-5-mini";
    state.session = createSession({
      send: vi.fn().mockRejectedValue(new Error("connection got disposed"))
    });

    (service as unknown as { guardrailsPromise: Promise<unknown> }).guardrailsPromise = Promise.resolve({
      version: 1,
      maxPromptLength: 4000,
      denyRules: [],
      allowRules: []
    });
    (service as unknown as {
      createSession: (chatId: number, cwd: string, model?: string) => Promise<void>;
    }).createSession = vi.fn().mockImplementation(async () => {
      state.session = replacementSession;
    });
    vi.spyOn(quotaService, "increment").mockResolvedValue(undefined);

    await (service as unknown as {
      handleMessage: (message: TelegramMessage) => Promise<void>;
    }).handleMessage(createMessage("請幫我整理部署步驟"));

    const keyboardCall = vi.mocked(api.sendMessage).mock.calls
      .map((call) => call[0])
      .find((payload) => payload.reply_markup) as { text: string; reply_markup: InlineKeyboardMarkup } | undefined;

    expect(keyboardCall?.text).toContain("已重建");
    expect(keyboardCall?.text).toContain("是否仍要發送原訊息");
    expect(keyboardCall?.reply_markup.inline_keyboard[0]?.[0]?.callback_data).toMatch(/^recovery\.resend:/);
    expect(keyboardCall?.reply_markup.inline_keyboard[0]?.[1]?.callback_data).toMatch(/^recovery\.cancel:/);
    expect(vi.mocked(replacementSession.send)).not.toHaveBeenCalled();
  });

  it("resends the stored prompt after passive recovery confirmation without routing again", async () => {
    const api = createApi();
    const service = new TeleTopazService(api, "1", "1", 0);
    const state = (service as unknown as {
      getOrCreateState: (chatId: number) => Record<string, unknown>;
    }).getOrCreateState(1);

    const replacementSession = createSession();
    const classifyIntent = vi.fn().mockResolvedValue("ROUTER");
    state.workDir = "/tmp/project";
    state.provider = "copilot";
    state.mode = "auto";
    state.routerModel = "gpt-5-mini";
    state.coreModel = "gpt-5.4";
    state.model = "gpt-5-mini";
    state.session = createSession({
      send: vi.fn().mockRejectedValue(new Error("connection got disposed"))
    });

    (service as unknown as { guardrailsPromise: Promise<unknown> }).guardrailsPromise = Promise.resolve({
      version: 1,
      maxPromptLength: 4000,
      denyRules: [],
      allowRules: []
    });
    (service as unknown as {
      createSession: (chatId: number, cwd: string, model?: string) => Promise<void>;
    }).createSession = vi.fn().mockImplementation(async () => {
      state.session = replacementSession;
    });
    (service as unknown as {
      classifyIntent: (chatId: number, text: string, routerModel: string) => Promise<"ROUTER" | "CORE">;
    }).classifyIntent = classifyIntent;
    vi.spyOn(quotaService, "increment").mockResolvedValue(undefined);

    await (service as unknown as {
      handleMessage: (message: TelegramMessage) => Promise<void>;
    }).handleMessage(createMessage("hello"));

    const keyboardCall = vi.mocked(api.sendMessage).mock.calls
      .map((call) => call[0])
      .find((payload) => payload.reply_markup) as { reply_markup: InlineKeyboardMarkup } | undefined;
    const resendData = keyboardCall?.reply_markup.inline_keyboard[0]?.[0]?.callback_data;

    expect(resendData).toBeTruthy();
    await (service as unknown as {
      handleCallback: (callback: TelegramCallbackQuery) => Promise<void>;
    }).handleCallback(createCallback(resendData!));

    expect(classifyIntent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(replacementSession.send)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(replacementSession.send)).toHaveBeenCalledWith("hello", []);
  });

  it("proactively rebuilds stale sessions without talking to the LLM", async () => {
    const api = createApi();
    const service = new TeleTopazService(api, "1", "1", 0);
    const state = (service as unknown as {
      getOrCreateState: (chatId: number) => Record<string, unknown>;
    }).getOrCreateState(1);

    const staleSession = createSession();
    const replacementSession = createSession();
    const classifyIntent = vi.fn();
    const sendPrompt = vi.fn();

    state.workDir = "/tmp/project";
    state.provider = "copilot";
    state.model = "gpt-5-mini";
    state.session = staleSession;
    state.processing = false;
    state.resetting = false;
    state.sessionCreatedAt = Date.now() - 61 * 60 * 1000;
    state.sessionLastActivityAt = Date.now() - 61 * 60 * 1000;

    (service as unknown as {
      createSession: (chatId: number, cwd: string, model?: string) => Promise<void>;
    }).createSession = vi.fn().mockImplementation(async () => {
      state.session = replacementSession;
      state.sessionCreatedAt = Date.now();
      state.sessionLastActivityAt = Date.now();
    });
    (service as unknown as {
      classifyIntent: typeof classifyIntent;
      sendPrompt: typeof sendPrompt;
    }).classifyIntent = classifyIntent;
    (service as unknown as {
      classifyIntent: typeof classifyIntent;
      sendPrompt: typeof sendPrompt;
    }).sendPrompt = sendPrompt;

    await (service as unknown as {
      checkSessionHealth: () => Promise<void>;
    }).checkSessionHealth();

    expect(classifyIntent).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(vi.mocked(staleSession.send)).not.toHaveBeenCalled();
    expect(vi.mocked(replacementSession.send)).not.toHaveBeenCalled();

    const noticeCall = vi.mocked(api.sendMessage).mock.calls
      .map((call) => call[0])
      .find((payload) => typeof payload.text === "string" && payload.text.includes("重建工作階段"));

    expect(noticeCall?.text).toContain("重建工作階段");
    expect(noticeCall?.reply_markup).toBeUndefined();
  });
});
