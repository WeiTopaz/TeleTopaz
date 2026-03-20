import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TeleTopazService } from "../src/bot.js";
import type { AiClient, AiSession } from "../src/provider/types.js";
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
    answerCallbackQuery: vi.fn(),
    downloadFile: vi.fn(),
  } as unknown as TelegramApi;
}

function makeMsg(text: string, chatId = 1, userId = 1, date?: number): TelegramMessage {
  return {
    message_id: 42,
    date: date ?? Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: "private" as const },
    from: { id: userId, first_name: "Test", is_bot: false },
    text,
  };
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

describe("command handling", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(vi.fn() as any);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("/help sends welcome message", async () => {
    const { service } = createService();
    await (service as any).handleCommand(makeMsg("/help"));
    expect((service as any).safeSend).toHaveBeenCalled();
  });

  it("/project sends directory list", async () => {
    const { service } = createService();
    (service as any).sendDirectoryList = vi.fn().mockResolvedValue(undefined);
    await (service as any).handleCommand(makeMsg("/project"));
    expect((service as any).sendDirectoryList).toHaveBeenCalledWith(1);
  });

  it("/info displays status with sendStatus", async () => {
    const { service } = createService();
    (service as any).sendStatus = vi.fn().mockResolvedValue(undefined);
    await (service as any).handleCommand(makeMsg("/info"));
    expect((service as any).sendStatus).toHaveBeenCalledWith(1);
  });

  it("/i is alias for /info", async () => {
    const { service } = createService();
    (service as any).sendStatus = vi.fn().mockResolvedValue(undefined);
    await (service as any).handleCommand(makeMsg("/i"));
    expect((service as any).sendStatus).toHaveBeenCalledWith(1);
  });

  it("/clear resets session and attachments via handleClear", async () => {
    const { service } = createService();
    (service as any).handleClear = vi.fn().mockResolvedValue(undefined);
    await (service as any).handleCommand(makeMsg("/clear"));
    expect((service as any).handleClear).toHaveBeenCalledWith(1);
  });

  it("/quit triggers shutdown on valid message date", async () => {
    const { service } = createService();
    (service as any).shutdown = vi.fn().mockResolvedValue(undefined);
    const msg = makeMsg("/quit");
    // date is current timestamp, startTimestamp is set to now — make date > startTimestamp
    msg.date = Math.floor(Date.now() / 1000) + 1;
    await (service as any).handleCommand(msg);
    expect((service as any).shutdown).toHaveBeenCalled();
  });

  it("/quit ignores old messages (date < startTimestamp)", async () => {
    const { service } = createService();
    (service as any).shutdown = vi.fn().mockResolvedValue(undefined);
    const oldDate = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    await (service as any).handleCommand(makeMsg("/quit", 1, 1, oldDate));
    expect((service as any).shutdown).not.toHaveBeenCalled();
  });

  it("rejects commands from non-owner", async () => {
    const { service } = createService();
    // chatId=2 is not the owner (owner is chatId=1)
    await (service as any).handleCommand(makeMsg("/help", 2, 2));
    expect((service as any).safeSend).toHaveBeenCalledWith(
      2,
      expect.stringContaining("擁有者"),
      expect.anything()
    );
  });

  it("unknown command sends error message", async () => {
    const { service } = createService();
    await (service as any).handleCommand(makeMsg("/nonexistent"));
    expect((service as any).safeSend).toHaveBeenCalledWith(
      1,
      expect.stringContaining("未知指令"),
      expect.anything()
    );
  });
});
