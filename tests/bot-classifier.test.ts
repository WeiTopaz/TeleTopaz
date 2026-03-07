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
    }).classifyIntent(1, "幫我看一下 README", "gpt-5-mini");

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(classifyPromise).resolves.toBe("ROUTER");

    const options = vi.mocked(client.createSession).mock.calls[0]?.[0] as {
      approvalMode?: string;
      workingDirectory?: string;
      onPermissionRequest?: (input: unknown) => Promise<unknown>;
      hooks?: { onPreToolUse?: (input: { toolName?: string; toolArgs?: Record<string, unknown> }) => Promise<unknown> };
    } | undefined;

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
