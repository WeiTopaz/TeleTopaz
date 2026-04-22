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

async function createSessionOptions() {
  const session: AiSession = {
    onEvent: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    sendAndWait: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined)
  };
  const client = createClient(session);
  const service = new TeleTopazService(createApi(), "1", "1", 0);

  (service as unknown as { loadAllowedDirectories: () => Promise<string[]> }).loadAllowedDirectories = vi.fn().mockResolvedValue(["/tmp/project"]);
  (service as unknown as { getModels: () => Promise<string[]> }).getModels = vi.fn().mockResolvedValue(["gpt-5-mini"]);
  (service as unknown as { createProviderClient: () => AiClient }).createProviderClient = vi.fn().mockReturnValue(client);
  (service as unknown as { safeSend: () => Promise<undefined> }).safeSend = vi.fn().mockResolvedValue(undefined);
  (service as unknown as { sessionMemory: { buildContext: (scope: unknown) => Promise<string | undefined> } }).sessionMemory = {
    buildContext: vi.fn().mockResolvedValue(undefined)
  };

  await (service as unknown as {
    createSession: (chatId: number, cwd: string, model?: string) => Promise<void>;
  }).createSession(1, "/tmp/project", "gpt-5-mini");

  return vi.mocked(client.createSession).mock.calls[0]?.[0] as {
    hooks?: { onPreToolUse?: (input: unknown) => Promise<unknown> };
    onPermissionRequest?: (input: unknown) => Promise<unknown>;
  } | undefined;
}

describe("TeleTopazService tool permissions", () => {
  it("allows Codex sessions to be created through the standard provider pipeline", async () => {
    const session: AiSession = {
      onEvent: vi.fn(),
      send: vi.fn().mockResolvedValue(undefined),
      sendAndWait: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined)
    };
    const client = createClient(session);
    const service = new TeleTopazService(createApi(), "1", "1", 0);
    const safeSend = vi.fn().mockResolvedValue(undefined);

    (service as unknown as { loadAllowedDirectories: () => Promise<string[]> }).loadAllowedDirectories = vi.fn().mockResolvedValue(["/tmp/project"]);
    (service as unknown as { getModels: (provider?: string) => Promise<string[]> }).getModels = vi.fn().mockResolvedValue(["gpt-5.4", "gpt-5.4-mini"]);
    (service as unknown as { createProviderClient: () => AiClient }).createProviderClient = vi.fn().mockReturnValue(client);
    (service as unknown as { safeSend: typeof safeSend }).safeSend = safeSend;
    (service as unknown as { sessionMemory: { buildContext: (scope: unknown) => Promise<string | undefined> } }).sessionMemory = {
      buildContext: vi.fn().mockResolvedValue(undefined)
    };

    await (service as unknown as {
      createSession: (chatId: number, cwd: string, model?: string) => Promise<void>;
    }).createSession(1, "/tmp/project", "cdcli:gpt-5.4");

    expect((service as unknown as { createProviderClient: ReturnType<typeof vi.fn> }).createProviderClient).toHaveBeenCalledWith("codex");
    expect(client.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.4" })
    );
  });

  it("denies read tools that target files outside the selected workspace", async () => {
    const options = await createSessionOptions();
    const onPreToolUse = options?.hooks?.onPreToolUse;

    await expect(
      onPreToolUse?.({
        toolName: "read_file",
        cwd: "/tmp/project",
        toolArgs: { path: "/tmp/outside/secrets.txt" }
      })
    ).resolves.toMatchObject({
      permissionDecision: "deny"
    });
  });

  it("denies secret-like files even when they are inside the workspace", async () => {
    const options = await createSessionOptions();
    const onPreToolUse = options?.hooks?.onPreToolUse;

    await expect(
      onPreToolUse?.({
        toolName: "read_file",
        cwd: "/tmp/project",
        toolArgs: { path: "/tmp/project/.env" }
      })
    ).resolves.toMatchObject({
      permissionDecision: "deny"
    });
  });

  it("allows normal read tools within the selected workspace", async () => {
    const options = await createSessionOptions();
    const onPreToolUse = options?.hooks?.onPreToolUse;

    await expect(
      onPreToolUse?.({
        toolName: "read_file",
        cwd: "/tmp/project",
        toolArgs: { path: "/tmp/project/src/index.ts" }
      })
    ).resolves.toMatchObject({
        permissionDecision: "allow"
      });
  });

  it("passes a permission handler that denies out-of-workspace reads", async () => {
    const options = await createSessionOptions();

    await expect(
      options?.onPermissionRequest?.({
        kind: "read",
        intention: "Read file",
        path: "/tmp/outside/secrets.txt"
      })
    ).resolves.toEqual({
      kind: "denied-no-approval-rule-and-could-not-request-from-user"
    });
  });

  it("passes a permission handler that approves safe workspace reads", async () => {
    const options = await createSessionOptions();

    await expect(
      options?.onPermissionRequest?.({
        kind: "read",
        intention: "Read file",
        path: "/tmp/project/src/index.ts"
      })
    ).resolves.toEqual({
      kind: "approved"
    });
  });
});
