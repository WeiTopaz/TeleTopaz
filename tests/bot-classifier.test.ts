import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
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

describe("TeleTopazService classifyIntent", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reuses the classifier client between messages instead of restarting Copilot CLI each time", async () => {
    vi.useFakeTimers();

    const sessions: AiSession[] = [];
    const client: AiClient = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockImplementation(async () => {
        let eventHandler: ((event: { type?: string; data?: unknown }) => void) | undefined;
        const session: AiSession = {
          onEvent: vi.fn((handler) => {
            eventHandler = handler;
          }),
          send: vi.fn().mockImplementation(async () => {
            eventHandler?.({ type: "assistant.message", data: { content: "ROUTER" } });
          }),
          sendAndWait: vi.fn().mockResolvedValue(undefined),
          destroy: vi.fn().mockResolvedValue(undefined),
          abort: vi.fn().mockResolvedValue(undefined)
        };
        sessions.push(session);
        return session;
      }),
      queryProviderInfo: vi.fn().mockResolvedValue({})
    };

    const service = new TeleTopazService(createApi(), "1", "1", 0);
    const createProviderClient = vi.fn().mockReturnValue(client);
    (service as unknown as { createProviderClient: () => AiClient }).createProviderClient = createProviderClient;

    const classifyIntent = (service as unknown as {
      classifyIntent: (chatId: number, text: string, routerModel: string) => Promise<"ROUTER" | "CORE">;
    }).classifyIntent.bind(service);

    const first = classifyIntent(1, "第一則訊息", "gpt-5-mini");
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(first).resolves.toBe("ROUTER");

    const second = classifyIntent(1, "第二則訊息", "gpt-5-mini");
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(second).resolves.toBe("ROUTER");

    expect(createProviderClient).toHaveBeenCalledTimes(1);
    expect(client.start).toHaveBeenCalledTimes(1);
    expect(client.createSession).toHaveBeenCalledTimes(2);
    expect(client.stop).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => vi.mocked(session.destroy).mock.calls.length === 1)).toBe(true);
  });

  it("creates classifier sessions with tools denied and a safe working directory", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    let eventHandler: ((event: { type?: string; data?: unknown }) => void) | undefined;
    const session: AiSession = {
      onEvent: vi.fn((handler) => {
        eventHandler = handler;
      }),
      send: vi.fn().mockImplementation(async () => {
        eventHandler?.({ type: "assistant.message", data: { content: "ROUTER" } });
      }),
      sendAndWait: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined)
    };
    const client = createClient(session);
    const service = new TeleTopazService(createApi(), "1", "1", 0);

    (service as unknown as { createProviderClient: () => AiClient }).createProviderClient = vi.fn().mockReturnValue(client);

    const classifyPromise = (service as unknown as {
      classifyIntent: (chatId: number, text: string, routerModel: string) => Promise<"ROUTER" | "CORE">;
    }).classifyIntent(1, "幫我看一下 README", "ctcli:gpt-5-mini");

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(classifyPromise).resolves.toBe("ROUTER");

    const options = vi.mocked(client.createSession).mock.calls[0]?.[0] as {
      model?: string;
      approvalMode?: string;
      workingDirectory?: string;
      onPermissionRequest?: (input: unknown) => Promise<unknown>;
      hooks?: { onPreToolUse?: (input: { toolName?: string; toolArgs?: Record<string, unknown> }) => Promise<unknown> };
    } | undefined;

    expect(options?.model).toBe("gpt-5-mini");
    expect(options?.approvalMode).toBe("plan");
    expect(options?.workingDirectory).toBe(path.resolve("."));
    expect(options?.onPermissionRequest).toBeTypeOf("function");
    await expect(options?.onPermissionRequest?.({
      kind: "read",
      intention: "Read file",
      path: "README.md"
    })).resolves.toEqual({
      kind: "denied-no-approval-rule-and-could-not-request-from-user"
    });
    expect(options?.hooks?.onPreToolUse).toBeTypeOf("function");
    await expect(options?.hooks?.onPreToolUse?.({
      toolName: "read_file",
      toolArgs: { path: "README.md" }
    })).resolves.toEqual({ permissionDecision: "deny" });

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
