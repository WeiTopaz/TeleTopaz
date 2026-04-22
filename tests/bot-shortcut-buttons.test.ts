import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TeleTopazService } from "../src/bot.js";
import type { AiClient, AiSession } from "../src/provider/types.js";
import type { TelegramApi } from "../src/telegram/api.js";
import type { TelegramMessage, TelegramCallbackQuery } from "../src/telegram/types.js";

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
    answerCallbackQuery: vi.fn(),
    downloadFile: vi.fn(),
  } as unknown as TelegramApi;
}

function createService() {
  const api = createApi();
  const session: AiSession = {
    onEvent: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    sendAndWait: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
  };
  const client: AiClient = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue(session),
    queryProviderInfo: vi.fn().mockResolvedValue({}),
  };

  const now = Math.floor(Date.now() / 1000);
  const service = new TeleTopazService(api, "1", "1", now);

  (service as any).loadAllowedDirectories = vi.fn().mockResolvedValue(["/tmp/project"]);
  (service as any).getModels = vi.fn().mockResolvedValue(["gpt-5-mini"]);
  (service as any).createProviderClient = vi.fn().mockReturnValue(client);
  (service as any).safeSend = vi.fn().mockResolvedValue({ message_id: 1 });
  (service as any).sessionMemory = { buildContext: vi.fn().mockResolvedValue(undefined) };

  return { service, api, session, client };
}

describe("shortcut buttons", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(vi.fn() as any);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("buildNavKeyboard returns 2 rows: first row 3 buttons, second row 3 buttons", () => {
    const { service } = createService();
    const keyboard = (service as any).buildNavKeyboard();
    expect(keyboard.inline_keyboard).toHaveLength(2);
    expect(keyboard.inline_keyboard[0]).toHaveLength(3);
    expect(keyboard.inline_keyboard[1]).toHaveLength(3);
  });

  it("buildNavKeyboard second row has correct callback_data", () => {
    const { service } = createService();
    const keyboard = (service as any).buildNavKeyboard();
    const secondRow = keyboard.inline_keyboard[1];
    expect(secondRow[0].callback_data).toBe("do.shortcut:teletopaz");
    expect(secondRow[1].callback_data).toBe("do.shortcut:diary");
    expect(secondRow[2].callback_data).toBe("do.shortcut:notebook");
  });

  it("handleShortcut teletopaz with matching directory calls createSession and sendStatusFooter", async () => {
    const { service } = createService();
    (service as any).loadAllowedDirectories = vi.fn().mockResolvedValue([
      "/home/user/TeleTopaz",
      "/home/user/MyDiary",
      "/home/user/MyNotebook",
    ]);
    (service as any).createSession = vi.fn().mockResolvedValue(undefined);
    (service as any).sendStatusFooter = vi.fn().mockResolvedValue(undefined);

    await (service as any).handleShortcut(1, "teletopaz");

    expect((service as any).createSession).toHaveBeenCalledWith(1, "/home/user/TeleTopaz", "gpt-5.4");
    expect((service as any).sendStatusFooter).toHaveBeenCalledWith(1);
  });

  it("handleShortcut with matching directory calls createSession and sendStatusFooter", async () => {
    const { service } = createService();
    (service as any).loadAllowedDirectories = vi.fn().mockResolvedValue([
      "/home/user/MyDiary",
      "/home/user/MyNotebook",
    ]);
    (service as any).createSession = vi.fn().mockResolvedValue(undefined);
    (service as any).sendStatusFooter = vi.fn().mockResolvedValue(undefined);

    await (service as any).handleShortcut(1, "diary");

    expect((service as any).createSession).toHaveBeenCalledWith(1, "/home/user/MyDiary", "gpt-5.4-mini");
    expect((service as any).sendStatusFooter).toHaveBeenCalledWith(1);
  });

  it("handleShortcut without matching directory sends error message", async () => {
    const { service } = createService();
    (service as any).loadAllowedDirectories = vi.fn().mockResolvedValue(["/tmp/other"]);
    (service as any).createSession = vi.fn().mockResolvedValue(undefined);
    (service as any).sendStatusFooter = vi.fn().mockResolvedValue(undefined);

    await (service as any).handleShortcut(1, "diary");

    expect((service as any).safeSend).toHaveBeenCalledWith(
      1,
      expect.stringContaining("MyDiary")
    );
    expect((service as any).createSession).not.toHaveBeenCalled();
  });

  it("handleShortcut with unknown key sends error", async () => {
    const { service } = createService();

    await (service as any).handleShortcut(1, "unknown");

    expect((service as any).safeSend).toHaveBeenCalledWith(1, "未知的快捷操作。");
  });

  it("handleCallback routes do.shortcut:notebook to handleShortcut", async () => {
    const { service } = createService();
    (service as any).handleShortcut = vi.fn().mockResolvedValue(undefined);

    const callback: TelegramCallbackQuery = {
      id: "cb1",
      chat_instance: "inst",
      from: { id: 1, first_name: "Test", is_bot: false },
      message: {
        message_id: 10,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 1, type: "private" as const },
      },
      data: "do.shortcut:notebook",
    };

    await (service as any).handleCallback(callback);

    expect((service as any).handleShortcut).toHaveBeenCalledWith(1, "notebook");
  });

  it("sendStatus uses buildNavKeyboard (keyboard has 2 rows)", async () => {
    const { service } = createService();
    // Mock buildStatusBlock to avoid complex setup
    (service as any).buildStatusBlock = vi.fn().mockResolvedValue("status text");
    (service as any).buildNavKeyboard = vi.fn().mockReturnValue({
      inline_keyboard: [
        [
          { text: "📁 專案", callback_data: "do.project" },
          { text: "⚙️ 模型", callback_data: "do.model" },
          { text: "📋 說明", callback_data: "do.info" },
        ],
        [
          { text: "TeleTopaz", callback_data: "do.shortcut:teletopaz" },
          { text: "📔 日記", callback_data: "do.shortcut:diary" },
          { text: "📓 筆記", callback_data: "do.shortcut:notebook" },
        ],
      ],
    });

    await (service as any).sendStatus(1);

    expect((service as any).buildNavKeyboard).toHaveBeenCalled();
  });
});
