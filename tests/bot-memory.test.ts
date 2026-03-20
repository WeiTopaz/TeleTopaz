import { describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
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

  it("passes built-in and workspace skill directories to Copilot sessions", async () => {
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
    (service as unknown as { findSkillsPath: (cwd: string) => Promise<string | undefined> }).findSkillsPath = vi.fn().mockResolvedValue("/tmp/project/.github/skills");
    (service as unknown as { sessionMemory: { buildContext: (scope: unknown) => Promise<string | undefined> } }).sessionMemory = {
      buildContext: vi.fn().mockResolvedValue(undefined)
    };

    await (service as unknown as {
      createSession: (chatId: number, cwd: string, model?: string) => Promise<void>;
    }).createSession(1, "/tmp/project", "gpt-5-mini");

    expect(client.createSession).toHaveBeenCalledOnce();
    const options = vi.mocked(client.createSession).mock.calls[0]?.[0];
    expect(options?.skillDirectories).toEqual(
      expect.arrayContaining([
        path.resolve(".github/skills"),
        "/tmp/project/.github/skills"
      ])
    );
  });

  it("uses read-only plan mode for Gemini sessions", async () => {
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
    const state = (service as unknown as {
      getOrCreateState: (chatId: number) => Record<string, unknown>;
    }).getOrCreateState(1);
    state.provider = "gemini";

    (service as unknown as { loadAllowedDirectories: () => Promise<string[]> }).loadAllowedDirectories = vi.fn().mockResolvedValue(["/tmp/project"]);
    (service as unknown as { getModels: () => Promise<string[]> }).getModels = vi.fn().mockResolvedValue(["gemini-3.1-pro-preview"]);
    (service as unknown as { createProviderClient: () => AiClient }).createProviderClient = vi.fn().mockReturnValue(client);
    (service as unknown as { safeSend: () => Promise<undefined> }).safeSend = vi.fn().mockResolvedValue(undefined);
    (service as unknown as { sessionMemory: { buildContext: (scope: unknown) => Promise<string | undefined> } }).sessionMemory = {
      buildContext: vi.fn().mockResolvedValue(undefined)
    };

    await (service as unknown as {
      createSession: (chatId: number, cwd: string, model?: string) => Promise<void>;
    }).createSession(1, "/tmp/project", "gemini-3.1-pro-preview");

    expect(client.createSession).toHaveBeenCalledOnce();
    const options = vi.mocked(client.createSession).mock.calls[0]?.[0] as { approvalMode?: string } | undefined;
    expect(options?.approvalMode).toBe("plan");
  });

  it("uses auto_edit mode for Claude Code sessions", async () => {
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
    const state = (service as unknown as {
      getOrCreateState: (chatId: number) => Record<string, unknown>;
    }).getOrCreateState(1);
    state.provider = "claude-code";

    (service as unknown as { loadAllowedDirectories: () => Promise<string[]> }).loadAllowedDirectories = vi.fn().mockResolvedValue(["/tmp/project"]);
    (service as unknown as { getModels: () => Promise<string[]> }).getModels = vi.fn().mockResolvedValue(["claude-opus-4.6"]);
    (service as unknown as { createProviderClient: () => AiClient }).createProviderClient = vi.fn().mockReturnValue(client);
    (service as unknown as { safeSend: () => Promise<undefined> }).safeSend = vi.fn().mockResolvedValue(undefined);
    (service as unknown as { sessionMemory: { buildContext: (scope: unknown) => Promise<string | undefined> } }).sessionMemory = {
      buildContext: vi.fn().mockResolvedValue(undefined)
    };

    await (service as unknown as {
      createSession: (chatId: number, cwd: string, model?: string) => Promise<void>;
    }).createSession(1, "/tmp/project", "claude-opus-4.6");

    expect(client.createSession).toHaveBeenCalledOnce();
    const options = vi.mocked(client.createSession).mock.calls[0]?.[0] as { approvalMode?: string } | undefined;
    expect(options?.approvalMode).toBe("auto_edit");
  });

  it("uses auto_edit mode for Claude Code router sessions", async () => {
    const api = createApi();
    const tempSession: AiSession = {
      onEvent: vi.fn(),
      send: vi.fn().mockResolvedValue(undefined),
      sendAndWait: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined)
    };
    const client = createClient(tempSession);
    const service = new TeleTopazService(api, "1", "1", 0);
    const state = (service as unknown as {
      getOrCreateState: (chatId: number) => Record<string, unknown>;
    }).getOrCreateState(1);

    state.workDir = "/tmp/project";
    state.routerModel = "cccli:claude-opus-4.6";
    state.provider = "copilot";
    state.model = "gpt-5-mini";

    (service as unknown as { createProviderClient: () => AiClient }).createProviderClient = vi.fn().mockReturnValue(client);
    (service as unknown as { safeSend: () => Promise<undefined> }).safeSend = vi.fn().mockResolvedValue(undefined);
    (service as unknown as { sendPreparedPrompt: () => Promise<void> }).sendPreparedPrompt = vi.fn().mockResolvedValue(undefined);
    (service as unknown as { sessionMemory: { buildContext: (scope: unknown) => Promise<string | undefined> } }).sessionMemory = {
      buildContext: vi.fn().mockResolvedValue(undefined)
    };

    await (service as unknown as {
      handleRouterCommand: (chatId: number, prompt: string) => Promise<void>;
    }).handleRouterCommand(1, "請幫我修正設定");

    expect(client.createSession).toHaveBeenCalledOnce();
    const options = vi.mocked(client.createSession).mock.calls[0]?.[0] as { approvalMode?: string } | undefined;
    expect(options?.approvalMode).toBe("auto_edit");
  });

  it("rejects workspace skills that resolve outside the selected workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "teletopaz-skills-"));
    const workspaceDir = path.join(root, "workspace");
    const externalSkillsDir = path.join(root, "external-skills");
    const workspaceGithubDir = path.join(workspaceDir, ".github");
    const workspaceSkillsLink = path.join(workspaceGithubDir, "skills");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await fs.mkdir(workspaceGithubDir, { recursive: true });
    await fs.mkdir(externalSkillsDir, { recursive: true });
    await fs.symlink(externalSkillsDir, workspaceSkillsLink, "dir");

    try {
      const service = new TeleTopazService(createApi(), "1", "1", 0);
      const found = await (service as unknown as {
        findSkillsPath: (cwd: string) => Promise<string | undefined>;
      }).findSkillsPath(workspaceDir);

      expect(found).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
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
