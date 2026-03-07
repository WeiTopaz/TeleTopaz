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

describe("TeleTopazService session memory", () => {
  it("adds persisted memory context when creating a session", async () => {
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

    (service as unknown as { loadAllowedDirectories: () => Promise<string[]> }).loadAllowedDirectories = vi.fn().mockResolvedValue(["/tmp/project"]);
    (service as unknown as { getModels: () => Promise<string[]> }).getModels = vi.fn().mockResolvedValue(["gpt-5-mini"]);
    (service as unknown as { createProviderClient: () => AiClient }).createProviderClient = vi.fn().mockReturnValue(client);
    (service as unknown as { safeSend: () => Promise<undefined> }).safeSend = vi.fn().mockResolvedValue(undefined);
    (service as unknown as { sessionMemory: { buildContext: (scope: unknown) => Promise<string | undefined> } }).sessionMemory = {
      buildContext: vi.fn().mockResolvedValue("最近記憶\n- [user] 請部署 staging")
    };

    await (service as unknown as {
      createSession: (chatId: number, cwd: string, model?: string) => Promise<void>;
    }).createSession(1, "/tmp/project", "gpt-5-mini");

    expect(client.createSession).toHaveBeenCalledOnce();
    const options = vi.mocked(client.createSession).mock.calls[0]?.[0];
    expect(options?.systemPrompt).toContain("最近記憶");
    expect(options?.systemPrompt).toContain("請部署 staging");
  });

  it("persists completed turns on session idle", async () => {
    const service = new TeleTopazService(createApi(), "1", "1", 0);
    const append = vi.fn().mockResolvedValue(undefined);
    (service as unknown as { sessionMemory: { append: (...args: unknown[]) => Promise<void> } }).sessionMemory = {
      append
    };

    const state = (service as unknown as {
      getOrCreateState: (chatId: number) => Record<string, unknown>;
    }).getOrCreateState(1);
    state.workDir = "/tmp/project";
    state.activePrompt = "請整理部署步驟";
    state.receivedAssistantMessage = true;
    state.lastAssistantMessageText = "我已整理 staging 與 production 的部署步驟";
    state.pendingTasks = [];
    state.awaitingReply = false;

    await (service as unknown as {
      handleEvent: (chatId: number, event: { type: string }) => Promise<void>;
    }).handleEvent(1, { type: "session.idle" });

    expect(append).toHaveBeenCalledTimes(2);
    expect(append).toHaveBeenNthCalledWith(
      1,
      { chatId: 1, workDir: "/tmp/project" },
      "user",
      "請整理部署步驟"
    );
    expect(append).toHaveBeenNthCalledWith(
      2,
      { chatId: 1, workDir: "/tmp/project" },
      "assistant",
      "我已整理 staging 與 production 的部署步驟"
    );
  });
});
