import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AiClient, AiSession, AiEvent } from "../src/provider/types.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────

// WhatsAppClient mock: must use regular function (not arrow) to support `new`
vi.mock("../src/whatsapp/client.js", () => ({
  WhatsAppClient: vi.fn().mockImplementation(function(this: Record<string, unknown>) {
    this["connect"] = vi.fn().mockResolvedValue(undefined);
    this["disconnect"] = vi.fn().mockResolvedValue(undefined);
    this["sendMessage"] = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock("../src/copilot/sdk.js", () => ({
  CopilotSdkClient: vi.fn(),
  normalizeModelInfos: vi.fn(),
}));
vi.mock("../src/claude/sdk.js", () => ({
  ClaudeCodeSdkClient: vi.fn(),
}));
vi.mock("../src/gemini/sdk.js", () => ({ GeminiSdkClient: vi.fn() }));
vi.mock("../src/gemini/pty-session.js", () => ({ GeminiPtyClient: vi.fn() }));
vi.mock("../src/session/persona.js", () => ({
  buildPersonaPrompt: vi.fn().mockResolvedValue("system"),
}));
vi.mock("../src/config/secrets.js", () => ({
  loadConfiguredRuntimeConfig: vi.fn().mockResolvedValue({ directoryPatterns: undefined }),
  loadSecrets: vi.fn(),
}));
vi.mock("../src/config/directories.js", () => ({
  loadDirectoryPatterns: vi.fn().mockResolvedValue([]),
  expandDirectoryPatterns: vi.fn().mockResolvedValue([]),
  isAllowedDirectory: vi.fn().mockReturnValue(true),
}));
vi.mock("../src/util/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ─── Types & helpers ──────────────────────────────────────────────────────────

type MockWaClient = {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
};

type MockService = {
  wa: MockWaClient;
  sessions: Map<string, unknown>;
  sessionMemory: { buildContext: ReturnType<typeof vi.fn>; append: ReturnType<typeof vi.fn> };
  handleMessage: (msg: unknown) => Promise<void>;
  handleCommand: (jid: string, text: string) => Promise<void>;
  handleAiEvent: (jid: string, event: AiEvent) => Promise<void>;
  processPrompt: (jid: string, prompt: string) => Promise<void>;
  clearSession: (jid: string) => Promise<void>;
};

async function buildService(ownerJid = "886912345678") {
  const { WhatsAppService } = await import("../src/whatsapp/service.js");
  const { CopilotSdkClient } = await import("../src/copilot/sdk.js");
  const { ClaudeCodeSdkClient } = await import("../src/claude/sdk.js");

  const mockSession: AiSession = {
    onEvent: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    sendAndWait: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
  };
  const mockAiClient: AiClient = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue(mockSession),
    queryProviderInfo: vi.fn().mockResolvedValue({}),
  };

  // Make AI client constructors return the mock client (must use regular function, not arrow)
  vi.mocked(CopilotSdkClient).mockImplementation(function() {
    return mockAiClient as unknown as InstanceType<typeof CopilotSdkClient>;
  });
  vi.mocked(ClaudeCodeSdkClient).mockImplementation(function() {
    return mockAiClient as unknown as InstanceType<typeof ClaudeCodeSdkClient>;
  });

  // Directly construct (constructor is private; bypass with cast)
  const svc = new (WhatsAppService as unknown as new (opts: unknown) => MockService)({
    ownerJids: [ownerJid],
    authDir: "/tmp/wa-auth",
    defaultModel: "claude-sonnet-4.6",
    defaultProvider: "claude-code",
    defaultWorkDir: "/tmp/project",
  });

  svc.sessionMemory = {
    buildContext: vi.fn().mockResolvedValue(undefined),
    append: vi.fn().mockResolvedValue(undefined),
  };

  return { svc, mockAiClient, mockSession };
}

function makeWaState(overrides: Partial<{
  processing: boolean; queue: string[]; lastPrompt: string | undefined; lastReply: string | undefined;
  model: string; provider: string; workDir: string; session: unknown; client: unknown;
}> = {}) {
  return {
    client: undefined, session: undefined,
    workDir: "/tmp/project", model: "claude-sonnet-4.6", provider: "claude-code",
    processing: false, queue: [] as string[], lastPrompt: undefined, lastReply: undefined,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("WhatsApp message routing", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("ignores messages from non-owner JID", async () => {
    const { svc } = await buildService("886912345678");
    await svc.handleMessage({ id: "1", from: "999999999@s.whatsapp.net", content: "hello", timestamp: 1, isGroup: false });
    expect(svc.wa.sendMessage).not.toHaveBeenCalled();
  });

  it("ignores group messages from owner", async () => {
    const { svc } = await buildService("886912345678");
    await svc.handleMessage({ id: "1", from: "886912345678@g.us", content: "hi", timestamp: 1, isGroup: true });
    expect(svc.wa.sendMessage).not.toHaveBeenCalled();
  });

  it("accepts owner matched by bare phone number", async () => {
    const { svc } = await buildService("886912345678");
    await svc.handleMessage({ id: "1", from: "886912345678@s.whatsapp.net", content: "hello", timestamp: 1, isGroup: false });
    // processPrompt is called — sends "⏳處理中…"
    expect(svc.wa.sendMessage).toHaveBeenCalled();
  });

  it("queues second message while first is processing", async () => {
    const { svc } = await buildService("886912345678");
    svc.sessions.set("886912345678@s.whatsapp.net", makeWaState({ processing: true }));

    await svc.handleMessage({ id: "2", from: "886912345678@s.whatsapp.net", content: "second", timestamp: 2, isGroup: false });

    const state = svc.sessions.get("886912345678@s.whatsapp.net") as ReturnType<typeof makeWaState>;
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0]).toBe("second");
    expect(svc.wa.sendMessage).toHaveBeenCalledWith(
      "886912345678@s.whatsapp.net",
      expect.stringContaining("已排隊"),
    );
  });
});

describe("WhatsApp commands", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("/info shows defaults when no session", async () => {
    const { svc } = await buildService("886912345678");
    await svc.handleCommand("jid@s.whatsapp.net", "/info");
    const msg = vi.mocked(svc.wa.sendMessage).mock.calls[0]?.[1] as string;
    expect(msg).toContain("claude-sonnet-4.6");
    expect(msg).toContain("未初始化");
  });

  it("/info shows active session details", async () => {
    const { svc, mockSession } = await buildService("886912345678");
    svc.sessions.set("jid", makeWaState({ session: mockSession, model: "gpt-5.4", provider: "copilot" }));
    await svc.handleCommand("jid", "/info");
    const msg = vi.mocked(svc.wa.sendMessage).mock.calls[0]?.[1] as string;
    expect(msg).toContain("gpt-5.4");
    expect(msg).toContain("已連線");
  });

  it("/model without arg shows current model", async () => {
    const { svc } = await buildService("886912345678");
    await svc.handleCommand("jid", "/model");
    const msg = vi.mocked(svc.wa.sendMessage).mock.calls[0]?.[1] as string;
    expect(msg).toContain("claude-sonnet-4.6");
  });

  it("/model with arg switches model", async () => {
    const { svc } = await buildService("886912345678");
    await svc.handleCommand("jid", "/model ctcli:gpt-5.4");
    const msg = vi.mocked(svc.wa.sendMessage).mock.calls[0]?.[1] as string;
    expect(msg).toContain("gpt-5.4");
    const state = svc.sessions.get("jid") as ReturnType<typeof makeWaState>;
    expect(state.model).toBe("gpt-5.4");
  });

  it("/clear destroys session and confirms", async () => {
    const { svc, mockSession, mockAiClient } = await buildService("886912345678");
    svc.sessions.set("jid", makeWaState({ session: mockSession, client: mockAiClient }));
    await svc.handleCommand("jid", "/clear");
    expect(mockSession.destroy).toHaveBeenCalled();
    expect(mockAiClient.stop).toHaveBeenCalled();
    const msg = vi.mocked(svc.wa.sendMessage).mock.calls[0]?.[1] as string;
    expect(msg).toContain("已清除");
  });

  it("/project without arg lists directories", async () => {
    const { loadConfiguredRuntimeConfig } = await import("../src/config/secrets.js");
    const { expandDirectoryPatterns, loadDirectoryPatterns } = await import("../src/config/directories.js");
    vi.mocked(loadConfiguredRuntimeConfig).mockResolvedValue({ directoryPatterns: "/tmp/foo,/tmp/bar" });
    vi.mocked(loadDirectoryPatterns).mockResolvedValue(["/tmp/foo", "/tmp/bar"]);
    vi.mocked(expandDirectoryPatterns).mockResolvedValue(["/tmp/foo", "/tmp/bar"]);
    const { svc } = await buildService("886912345678");
    await svc.handleCommand("jid", "/project");
    const msg = vi.mocked(svc.wa.sendMessage).mock.calls[0]?.[1] as string;
    expect(msg).toContain("foo");
    expect(msg).toContain("bar");
  });

  it("unknown command shows help hint", async () => {
    const { svc } = await buildService("886912345678");
    await svc.handleCommand("jid", "/unknown");
    const msg = vi.mocked(svc.wa.sendMessage).mock.calls[0]?.[1] as string;
    expect(msg).toContain("未知命令");
  });
});

describe("AI event handling", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("assistant.message sends reply and stores it", async () => {
    const { svc } = await buildService("886912345678");
    svc.sessions.set("jid", makeWaState({ processing: true, lastPrompt: "q" }));

    await svc.handleAiEvent("jid", { type: "assistant.message", data: { content: "Hello AI" } });

    expect(svc.wa.sendMessage).toHaveBeenCalledWith("jid", "Hello AI");
    const state = svc.sessions.get("jid") as ReturnType<typeof makeWaState>;
    expect(state.lastReply).toBe("Hello AI");
  });

  it("assistant.message handles text field fallback", async () => {
    const { svc } = await buildService("886912345678");
    svc.sessions.set("jid", makeWaState({ processing: true, lastPrompt: "q" }));
    await svc.handleAiEvent("jid", { type: "assistant.message", data: { text: "text fallback" } });
    expect(svc.wa.sendMessage).toHaveBeenCalledWith("jid", "text fallback");
  });

  it("session.idle clears processing and persists memory", async () => {
    const { svc } = await buildService("886912345678");
    svc.sessions.set("jid", makeWaState({ processing: true, lastPrompt: "question", lastReply: "answer" }));

    await svc.handleAiEvent("jid", { type: "session.idle", data: {} });

    const state = svc.sessions.get("jid") as ReturnType<typeof makeWaState>;
    expect(state.processing).toBe(false);
    expect(state.lastPrompt).toBeUndefined();
    expect(state.lastReply).toBeUndefined();
    expect(svc.sessionMemory.append).toHaveBeenCalledTimes(2);
  });

  it("session.idle processes next queued message", async () => {
    const { svc } = await buildService("886912345678");
    const spyProcess = vi.spyOn(svc, "processPrompt").mockResolvedValue(undefined);

    svc.sessions.set("jid", makeWaState({
      processing: true, queue: ["next msg"], lastPrompt: "done", lastReply: "done",
    }));

    await svc.handleAiEvent("jid", { type: "session.idle", data: {} });
    await new Promise((r) => setTimeout(r, 0)); // flush microtasks

    expect(spyProcess).toHaveBeenCalledWith("jid", "next msg");
  });

  it("long response is split into ≤4000 char chunks", async () => {
    const { svc } = await buildService("886912345678");
    svc.sessions.set("jid", makeWaState({ processing: true, lastPrompt: "q" }));

    const longText = "x".repeat(9000); // 9000 chars → 3 chunks
    await svc.handleAiEvent("jid", { type: "assistant.message", data: { content: longText } });

    const calls = vi.mocked(svc.wa.sendMessage).mock.calls;
    expect(calls.length).toBe(3); // intentional: 9000/4000 = 3 chunks
    for (const [, text] of calls) {
      expect((text as string).length).toBeLessThanOrEqual(4000);
    }
  });
});
