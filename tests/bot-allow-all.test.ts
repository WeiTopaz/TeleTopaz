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
  (service as any).safeSend = vi.fn().mockResolvedValue(undefined);
  (service as any).sessionMemory = { buildContext: vi.fn().mockResolvedValue(undefined) };

  return { service, api, client };
}

describe("/allowall command", () => {
  it("toggles allowAll on and off", async () => {
    const { service } = createService();
    const getState = (service as any).getOrCreateState.bind(service);
    const state = getState(1);

    expect(state.allowAll).toBe(false);

    await (service as any).handleAllowAllToggle(1);
    expect(state.allowAll).toBe(true);

    await (service as any).handleAllowAllToggle(1);
    expect(state.allowAll).toBe(false);
  });

  it("sends appropriate status message on toggle", async () => {
    const { service } = createService();
    const safeSend = (service as any).safeSend;

    await (service as any).handleAllowAllToggle(1);
    expect(safeSend).toHaveBeenCalledWith(1, expect.stringContaining("全部允許"));

    safeSend.mockClear();
    await (service as any).handleAllowAllToggle(1);
    expect(safeSend).toHaveBeenCalledWith(1, expect.stringContaining("操作確認"));
  });

  it("auto-approves interactive approval when allowAll is true", async () => {
    const { service } = createService();
    const state = (service as any).getOrCreateState(1);
    state.allowAll = true;

    const result = await (service as any).requestInteractiveApproval(1, "write", "test");
    expect(result).toBe(true);
    // safeSend should NOT have been called (no confirmation prompt)
    expect((service as any).safeSend).not.toHaveBeenCalled();
  });

  it("shows confirmation prompt when allowAll is false", async () => {
    const { service } = createService();
    const state = (service as any).getOrCreateState(1);
    state.allowAll = false;

    // Start the approval (it will wait for a callback that never comes)
    const approvalPromise = (service as any).requestInteractiveApproval(1, "write", "test");

    // Let microtasks flush so the pending map is populated
    await new Promise((r) => setTimeout(r, 10));

    // Verify a confirmation message was sent with inline keyboard
    expect((service as any).safeSend).toHaveBeenCalledWith(
      1,
      expect.stringContaining("需要確認"),
      undefined,
      expect.objectContaining({
        inline_keyboard: expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({ text: "✅ 允許" }),
            expect.objectContaining({ text: "❌ 拒絕" })
          ])
        ])
      })
    );

    // Resolve via pending confirmations to avoid timeout leak
    const pendingMap = (service as any).pendingToolConfirmations as Map<string, { resolve: (v: boolean) => void }>;
    for (const [, pending] of pendingMap) {
      pending.resolve(false);
    }
    await approvalPromise;
  });

  it("creates Codex sessions in read-only plan mode when allowAll is false", async () => {
    const { service, client } = createService();
    const state = (service as any).getOrCreateState(1);
    state.provider = "codex";
    state.allowAll = false;

    await (service as any).createSession(1, "/tmp/project", "gpt-5.4-mini", { announce: false });

    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({
      approvalMode: "plan"
    }));
  });

  it("rebuilds an active Codex session when toggling allowAll so the new approval mode takes effect immediately", async () => {
    const { service, client } = createService();
    const state = (service as any).getOrCreateState(1);
    const session = {
      destroy: vi.fn().mockResolvedValue(undefined),
      onEvent: vi.fn(),
      send: vi.fn().mockResolvedValue(undefined),
      sendAndWait: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined)
    };

    state.provider = "codex";
    state.allowAll = true;
    state.workDir = "/tmp/project";
    state.model = "gpt-5.4-mini";
    state.session = session;
    state.client = client;

    await (service as any).handleAllowAllToggle(1);

    expect(session.destroy).toHaveBeenCalledOnce();
    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-5.4-mini",
      approvalMode: "plan"
    }));
  });
});
