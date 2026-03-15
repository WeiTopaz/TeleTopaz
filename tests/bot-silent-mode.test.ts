import { describe, expect, it, vi } from "vitest";
import { TeleTopazService } from "../src/bot.js";
import type { AiClient, AiSession } from "../src/provider/types.js";
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

function createClient(session: AiSession): AiClient {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue(session),
    queryProviderInfo: vi.fn().mockResolvedValue({})
  };
}

function createService() {
  const api = createApi();
  const session: AiSession = {
    onEvent: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    sendAndWait: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined)
  };
  const client = createClient(session);
  const service = new TeleTopazService(api, "1", "1", 0);

  (service as any).loadAllowedDirectories = vi.fn().mockResolvedValue(["/tmp/project"]);
  (service as any).getModels = vi.fn().mockResolvedValue(["gpt-5-mini"]);
  (service as any).createProviderClient = vi.fn().mockReturnValue(client);
  (service as any).safeSend = vi.fn().mockResolvedValue({ message_id: 42 });
  (service as any).editMessageSafe = vi.fn().mockResolvedValue(undefined);
  (service as any).sessionMemory = { buildContext: vi.fn().mockResolvedValue(undefined) };

  return { service, api, client };
}

describe("/silent command", () => {
  it("defaults silentMode to true", () => {
    const { service } = createService();
    const state = (service as any).getOrCreateState(1);
    expect(state.silentMode).toBe(true);
    expect(state.silentAnchorMessageId).toBeUndefined();
  });

  it("toggles silentMode off then on", async () => {
    const { service } = createService();
    const state = (service as any).getOrCreateState(1);

    await (service as any).handleSilentToggle(1);
    expect(state.silentMode).toBe(false);

    await (service as any).handleSilentToggle(1);
    expect(state.silentMode).toBe(true);
  });

  it("sends appropriate status message on toggle", async () => {
    const { service } = createService();
    const safeSend = (service as any).safeSend;

    // First toggle turns it off (default is on)
    await (service as any).handleSilentToggle(1);
    expect(safeSend).toHaveBeenCalledWith(1, expect.stringContaining("關閉安靜模式"));

    safeSend.mockClear();
    await (service as any).handleSilentToggle(1);
    expect(safeSend).toHaveBeenCalledWith(1, expect.stringContaining("開啟安靜模式"));
  });

  it("clears anchor when silent mode is turned off", async () => {
    const { service } = createService();
    const state = (service as any).getOrCreateState(1);
    state.silentAnchorMessageId = 99;

    await (service as any).handleSilentToggle(1);
    expect(state.silentMode).toBe(false);
    expect(state.silentAnchorMessageId).toBeUndefined();
  });
});

describe("silentSend", () => {
  it("creates anchor on first call", async () => {
    const { service } = createService();
    const state = (service as any).getOrCreateState(1);
    state.silentMode = true;

    const result = await (service as any).silentSend(1, "test message");
    expect(result).toEqual({ message_id: 42 });
    expect(state.silentAnchorMessageId).toBe(42);
    expect((service as any).safeSend).toHaveBeenCalledWith(1, "test message", undefined);
  });

  it("edits anchor on subsequent calls", async () => {
    const { service } = createService();
    const state = (service as any).getOrCreateState(1);
    state.silentMode = true;
    state.silentAnchorMessageId = 42;

    const result = await (service as any).silentSend(1, "updated text");
    expect(result).toBeUndefined();
    expect((service as any).editMessageSafe).toHaveBeenCalledWith(1, 42, "updated text");
    expect((service as any).safeSend).not.toHaveBeenCalled();
  });

  it("passes replyTo when creating anchor", async () => {
    const { service } = createService();
    (service as any).getOrCreateState(1);

    await (service as any).silentSend(1, "test", 10);
    expect((service as any).safeSend).toHaveBeenCalledWith(1, "test", 10);
  });
});

describe("anchor lifecycle", () => {
  it("resets anchor in preparePromptDispatch", () => {
    const { service } = createService();
    const state = (service as any).getOrCreateState(1);
    state.silentAnchorMessageId = 99;
    state.session = {};

    (service as any).preparePromptDispatch(state, "test prompt", 1);
    expect(state.silentAnchorMessageId).toBeUndefined();
  });

  it("resets anchor in handleClear", async () => {
    const { service } = createService();
    const state = (service as any).getOrCreateState(1);
    state.silentAnchorMessageId = 99;

    // handleClear without workDir/model goes early return
    await (service as any).handleClear(1);
    expect(state.silentAnchorMessageId).toBeUndefined();
  });
});

describe("sendDoneNotice silent mode", () => {
  it("uses silentSend when silent mode is on", async () => {
    const { service } = createService();
    const state = (service as any).getOrCreateState(1);
    state.silentMode = true;
    state.receivedAssistantMessage = true;

    // Spy on silentSend
    const silentSend = vi.spyOn(service as any, "silentSend").mockResolvedValue(undefined);

    await (service as any).sendDoneNotice(1, state);
    expect(silentSend).toHaveBeenCalledWith(1, "✅完成");
  });

  it("includes prompt summary when no assistant message received", async () => {
    const { service } = createService();
    const state = (service as any).getOrCreateState(1);
    state.silentMode = true;
    state.receivedAssistantMessage = false;
    state.activePrompt = "my test prompt";

    const silentSend = vi.spyOn(service as any, "silentSend").mockResolvedValue(undefined);

    await (service as any).sendDoneNotice(1, state);
    expect(silentSend).toHaveBeenCalledWith(1, "✅完成：my test prompt");
  });

  it("falls back to normal behavior when silent mode is off", async () => {
    const { service } = createService();
    const state = (service as any).getOrCreateState(1);
    state.silentMode = false;
    state.processingMessageId = 55;
    state.receivedAssistantMessage = true;

    await (service as any).sendDoneNotice(1, state);
    expect((service as any).editMessageSafe).toHaveBeenCalledWith(1, 55, "✅完成");
    expect(state.processingMessageId).toBeUndefined();
  });
});

describe("handleToolStart silent mode", () => {
  it("uses silentSend without keyboard in silent mode", async () => {
    const { service } = createService();
    const state = (service as any).getOrCreateState(1);
    state.silentMode = true;
    state.silentAnchorMessageId = 42;

    const silentSend = vi.spyOn(service as any, "silentSend").mockResolvedValue(undefined);

    await (service as any).handleToolStart(1, state, {
      toolName: "readFile",
      toolCallId: "call-1",
      args: { path: "/tmp/test.txt" }
    });

    expect(silentSend).toHaveBeenCalledWith(1, expect.stringContaining("工具執行中：readFile"));
    // safeSend should NOT have been called directly (only through silentSend)
    expect((service as any).safeSend).not.toHaveBeenCalled();
  });

  it("tracks tool with anchor messageId in silent mode", async () => {
    const { service } = createService();
    const state = (service as any).getOrCreateState(1);
    state.silentMode = true;
    state.silentAnchorMessageId = 42;

    vi.spyOn(service as any, "silentSend").mockResolvedValue(undefined);

    await (service as any).handleToolStart(1, state, {
      toolName: "readFile",
      toolCallId: "call-1"
    });

    const tracking = state.toolMessageMap.get("call-1");
    expect(tracking).toBeDefined();
    expect(tracking.messageId).toBe(42);
    expect(tracking.toolName).toBe("readFile");
  });

  it("sends with keyboard in normal mode", async () => {
    const { service } = createService();
    const state = (service as any).getOrCreateState(1);
    state.silentMode = false;

    await (service as any).handleToolStart(1, state, {
      toolName: "readFile",
      toolCallId: "call-1"
    });

    expect((service as any).safeSend).toHaveBeenCalledWith(
      1,
      expect.stringContaining("工具執行中：readFile"),
      undefined,
      expect.objectContaining({
        inline_keyboard: expect.any(Array)
      })
    );
  });
});

describe("handleToolComplete silent mode", () => {
  it("edits anchor instead of tool message in silent mode", async () => {
    const { service } = createService();
    const state = (service as any).getOrCreateState(1);
    state.silentMode = true;
    state.silentAnchorMessageId = 42;
    state.toolMessageMap.set("call-1", {
      messageId: 100,
      resultKey: "r1",
      paramsKey: "p1",
      toolName: "readFile",
      callId: "call-1"
    });

    // Mock guardrails
    (service as any).guardrailsPromise = Promise.resolve({ maxPromptLength: 4000 });

    await (service as any).handleToolComplete(1, state, {
      toolCallId: "call-1",
      result: "file content"
    });

    expect((service as any).editMessageSafe).toHaveBeenCalledWith(
      1,
      42,
      expect.stringContaining("工具完成：readFile")
    );
    // Should not have keyboard in silent mode
    expect((service as any).editMessageSafe).toHaveBeenCalledWith(
      1,
      42,
      expect.any(String)
    );
  });
});

describe("status display includes silent mode", () => {
  it("buildStatusBlock includes silent mode line", async () => {
    const { service } = createService();
    const state = (service as any).getOrCreateState(Number("1"));
    state.silentMode = true;

    // Mock fetchOwnerName
    (service as any).fetchOwnerName = vi.fn().mockResolvedValue("TestUser");

    const block = await (service as any).buildStatusBlock(Number("1"));
    expect(block).toContain("🔇 安靜模式：開啟");
    expect(block).toContain("/silent — 切換安靜/正常通知模式");
  });

  it("shows 關閉 when silent mode is off", async () => {
    const { service } = createService();
    const state = (service as any).getOrCreateState(Number("1"));
    state.silentMode = false;

    (service as any).fetchOwnerName = vi.fn().mockResolvedValue("TestUser");

    const block = await (service as any).buildStatusBlock(Number("1"));
    expect(block).toContain("🔇 安靜模式：關閉");
  });
});
