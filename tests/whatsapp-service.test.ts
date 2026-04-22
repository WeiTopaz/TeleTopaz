import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AiClient, AiSession, AiEvent } from "../src/provider/types.js";
import type { WaState, WaPendingTask } from "../src/whatsapp/service.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockSendMessage = vi.fn().mockResolvedValue({ id: "mock-id", remoteJid: "jid@s.whatsapp.net", fromMe: true });
const mockSendPresenceUpdate = vi.fn().mockResolvedValue(undefined);
const mockSendReaction = vi.fn().mockResolvedValue(undefined);
const mockMarkAsRead = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/whatsapp/client.js", () => ({
  WhatsAppClient: vi.fn().mockImplementation(function(this: Record<string, unknown>) {
    this["connect"] = vi.fn().mockResolvedValue(undefined);
    this["disconnect"] = vi.fn().mockResolvedValue(undefined);
    this["sendMessage"] = mockSendMessage;
    this["sendPresenceUpdate"] = mockSendPresenceUpdate;
    this["sendReaction"] = mockSendReaction;
    this["markAsRead"] = mockMarkAsRead;
    this["sendImage"] = vi.fn().mockResolvedValue({ id: "img-id", remoteJid: "jid@s.whatsapp.net", fromMe: true });
    this["sendDocument"] = vi.fn().mockResolvedValue({ id: "doc-id", remoteJid: "jid@s.whatsapp.net", fromMe: true });
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
  loadWaOwnerJids: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/config/directories.js", () => ({
  loadDirectoryPatterns: vi.fn().mockResolvedValue([]),
  expandDirectoryPatterns: vi.fn().mockResolvedValue([]),
  isAllowedDirectory: vi.fn().mockReturnValue(true),
}));
vi.mock("../src/util/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../src/guardrails/guardrails.js", () => ({
  loadGuardrails: vi.fn().mockResolvedValue({ version: 1, maxPromptLength: 4096, denyRules: [], allowRules: [] }),
  evaluatePrompt: vi.fn().mockReturnValue({ allowed: true, source: "default" }),
  evaluatePromptWithOptions: vi.fn().mockReturnValue({ allowed: true, source: "default" }),
  guardToolOutput: vi.fn().mockReturnValue({ blocked: false, text: "tool result text" }),
}));
vi.mock("../src/whatsapp/markdown.js", () => ({
  markdownToWhatsApp: vi.fn((t: string) => t),
  splitLongMessage: vi.fn((t: string, limit = 4000) => {
    if (t.length <= limit) return [t];
    const chunks: string[] = [];
    for (let i = 0; i < t.length; i += limit) chunks.push(t.slice(i, i + limit));
    return chunks;
  }),
}));

// ─── Types & helpers ──────────────────────────────────────────────────────────

type MockWaClient = {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  sendPresenceUpdate: ReturnType<typeof vi.fn>;
  sendReaction: ReturnType<typeof vi.fn>;
  markAsRead: ReturnType<typeof vi.fn>;
  sendImage: ReturnType<typeof vi.fn>;
  sendDocument: ReturnType<typeof vi.fn>;
};

type MockService = {
  wa: MockWaClient;
  sessions: Map<string, WaState>;
  sessionMemory: { buildContext: ReturnType<typeof vi.fn>; append: ReturnType<typeof vi.fn> };
  handleMessage: (msg: unknown) => Promise<void>;
  handleCommand: (jid: string, text: string, msg: unknown) => Promise<void>;
  handleAiEvent: (jid: string, event: AiEvent) => Promise<void>;
  processPrompt: (jid: string, task: WaPendingTask) => Promise<void>;
  clearSession: (jid: string) => Promise<void>;
  getOrCreateState: (jid: string) => WaState;
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

  vi.mocked(CopilotSdkClient).mockImplementation(function() {
    return mockAiClient as unknown as InstanceType<typeof CopilotSdkClient>;
  });
  vi.mocked(ClaudeCodeSdkClient).mockImplementation(function() {
    return mockAiClient as unknown as InstanceType<typeof ClaudeCodeSdkClient>;
  });

  const svc = new (WhatsAppService as unknown as new (opts: unknown) => MockService)({
    ownerJids: [ownerJid],
    authDir: "/tmp/wa-auth",
    defaultModel: "gpt-5.4",
    defaultProvider: "copilot",
    defaultWorkDir: "/tmp/project",
  });

  svc.sessionMemory = {
    buildContext: vi.fn().mockResolvedValue(undefined),
    append: vi.fn().mockResolvedValue(undefined),
  };

  return { svc, mockAiClient, mockSession };
}

function makeWaState(overrides: Partial<WaState> = {}): WaState {
    return {
      client: undefined,
      session: undefined,
      workDir: "/tmp/project",
      model: "gpt-5.4",
      provider: "copilot",
      mode: "manual",
      routerModel: undefined,
      coreModel: undefined,
    processing: false,
    pendingTasks: [],
    lastPrompt: undefined,
    lastReply: undefined,
    sessionCreatedAt: undefined,
    sessionLastActivityAt: undefined,
    pendingRecovery: undefined,
    promptCycles: 0,
    allowAll: false,
    silentMode: false,
    toolMessageMap: new Map(),
    currentAttachments: [],
    ...overrides,
  };
}

function makeTask(prompt: string, attachments: WaPendingTask["attachments"] = []): WaPendingTask {
  return { prompt, attachments, queuedAt: Date.now() };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("WhatsApp message routing", () => {
  beforeEach(() => { vi.clearAllMocks(); mockSendMessage.mockResolvedValue({ id: "mock-id", remoteJid: "jid@s.whatsapp.net", fromMe: true }); });

  it("ignores messages from non-owner JID", async () => {
    const { svc } = await buildService("886912345678");
    await svc.handleMessage({ id: "1", from: "999999999@s.whatsapp.net", content: "hello", timestamp: 1, isGroup: false, messageKey: { id: "1", remoteJid: "999999999@s.whatsapp.net", fromMe: false } });
    expect(svc.wa.sendMessage).not.toHaveBeenCalled();
  });

  it("ignores group messages from non-owner participant", async () => {
    const { svc } = await buildService("886912345678");
    await svc.handleMessage({ id: "1", from: "123@g.us", participant: "999999999@s.whatsapp.net", content: "hi", timestamp: 1, isGroup: true, messageKey: { id: "1", remoteJid: "123@g.us", fromMe: false } });
    expect(svc.wa.sendMessage).not.toHaveBeenCalled();
  });

  it("accepts owner matched by bare phone number", async () => {
    const { svc } = await buildService("886912345678");
    await svc.handleMessage({ id: "1", from: "886912345678@s.whatsapp.net", content: "hello", timestamp: 1, isGroup: false, messageKey: { id: "1", remoteJid: "886912345678@s.whatsapp.net", fromMe: true } });
    expect(svc.wa.sendMessage).toHaveBeenCalled();
  });

  it("queues second message while first is processing", async () => {
    const { svc } = await buildService("886912345678");
    const jid = "886912345678@s.whatsapp.net";
    svc.sessions.set(jid, makeWaState({ processing: true }));

    await svc.handleMessage({ id: "2", from: jid, content: "second", timestamp: 2, isGroup: false, messageKey: { id: "2", remoteJid: jid, fromMe: true } });

    const state = svc.sessions.get(jid)!;
    expect(state.pendingTasks).toHaveLength(1);
    expect(state.pendingTasks[0]!.prompt).toBe("second");
    expect(svc.wa.sendMessage).toHaveBeenCalledWith(jid, expect.stringContaining("已排隊"));
  });

  it("rejects prompt when guardrails deny it", async () => {
    const { evaluatePrompt } = await import("../src/guardrails/guardrails.js");
    vi.mocked(evaluatePrompt).mockReturnValueOnce({ allowed: false, source: "builtin", ruleId: "test_rule", reason: "惡意內容" });

    const { svc } = await buildService("886912345678");
    const jid = "886912345678@s.whatsapp.net";
    await svc.handleMessage({ id: "3", from: jid, content: "惡意指令", timestamp: 3, isGroup: false, messageKey: { id: "3", remoteJid: jid, fromMe: true } });

    const msg = vi.mocked(svc.wa.sendMessage).mock.calls[0]?.[1] as string;
    expect(msg).toContain("提示詞被拒絕");
    expect(msg).toContain("惡意內容");
  });

  it("returns queue full message when pending tasks exceed limit", async () => {
    const { svc } = await buildService("886912345678");
    const jid = "886912345678@s.whatsapp.net";
    const pendingTasks = Array.from({ length: 15 }, (_, i) => makeTask(`task ${i}`));
    svc.sessions.set(jid, makeWaState({ processing: true, pendingTasks }));

    await svc.handleMessage({ id: "overflow", from: jid, content: "overflow", timestamp: 5, isGroup: false, messageKey: { id: "overflow", remoteJid: jid, fromMe: true } });

    const msg = vi.mocked(svc.wa.sendMessage).mock.calls[0]?.[1] as string;
    expect(msg).toContain("待辦已滿");
  });

  it("calls markAsRead on the WA client when an owner message is received", async () => {
    const { svc } = await buildService("886912345678");
    const jid = "886912345678@s.whatsapp.net";
    const msgKey = { id: "msg-read-id", remoteJid: jid, fromMe: false };
    await svc.handleMessage({ id: "msg-read-id", from: jid, content: "hello", timestamp: 1, isGroup: false, messageKey: msgKey });

    expect(svc.wa.markAsRead).toHaveBeenCalledWith(jid, msgKey);
  });
});

describe("WhatsApp commands", () => {
  beforeEach(() => { vi.clearAllMocks(); mockSendMessage.mockResolvedValue({ id: "mock-id", remoteJid: "jid@s.whatsapp.net", fromMe: true }); });

  const dummyMsg = { id: "1", from: "jid", content: "/help", timestamp: 1, isGroup: false, messageKey: { id: "1", remoteJid: "jid", fromMe: true } };

  it("/help shows full command list", async () => {
    const { svc } = await buildService("886912345678");
    await svc.handleCommand("jid", "/help", dummyMsg);
    const msg = vi.mocked(svc.wa.sendMessage).mock.calls[0]?.[1] as string;
    expect(msg).toContain("/info");
    expect(msg).toContain("/model");
    expect(msg).toContain("/project");
    expect(msg).toContain("/clear");
    expect(msg).toContain("/silent");
    expect(msg).toContain("/allowall");
    expect(msg).toContain("/router");
  });

  it("/info shows defaults when no session", async () => {
    const { svc } = await buildService("886912345678");
    await svc.handleCommand("jid@s.whatsapp.net", "/info", dummyMsg);
    const msg = vi.mocked(svc.wa.sendMessage).mock.calls[0]?.[1] as string;
    expect(msg).toContain("gpt-5.4");
    expect(msg).toContain("未初始化");
  });

  it("/info shows active session details with promptCycles", async () => {
    const { svc, mockSession } = await buildService("886912345678");
    svc.sessions.set("jid", makeWaState({ session: mockSession as unknown as AiSession, model: "gpt-5.4", provider: "copilot", promptCycles: 3 }));
    await svc.handleCommand("jid", "/info", dummyMsg);
    const msg = vi.mocked(svc.wa.sendMessage).mock.calls[0]?.[1] as string;
    expect(msg).toContain("gpt-5.4");
    expect(msg).toContain("已連線");
    expect(msg).toContain("3");
  });

  it("/model without arg shows current model", async () => {
    const { svc } = await buildService("886912345678");
    await svc.handleCommand("jid", "/model", dummyMsg);
    const msg = vi.mocked(svc.wa.sendMessage).mock.calls[0]?.[1] as string;
    expect(msg).toContain("gpt-5.4");
  });

  it("/model with arg switches model", async () => {
    const { svc } = await buildService("886912345678");
    await svc.handleCommand("jid", "/model ctcli:gpt-5.4", dummyMsg);
    const msg = vi.mocked(svc.wa.sendMessage).mock.calls[0]?.[1] as string;
    expect(msg).toContain("gpt-5.4");
    const state = svc.sessions.get("jid")!;
    expect(state.model).toBe("gpt-5.4");
    expect(state.mode).toBe("manual");
  });

  it("/router strips the provider prefix before creating the routed session", async () => {
    const { svc, mockAiClient } = await buildService("886912345678");
    svc.sessions.set("jid", makeWaState({ mode: "auto", routerModel: "cccli:claude-haiku-4.5" }));

    await svc.handleCommand("jid", "/router 請幫我整理待辦", dummyMsg);

    expect(mockAiClient.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4.5", approvalMode: "auto_edit" })
    );
    const state = svc.sessions.get("jid")!;
    expect(state.provider).toBe("claude-code");
    expect(state.model).toBe("claude-haiku-4.5");
  });

  it("/clear destroys session and confirms", async () => {
    const { svc, mockSession, mockAiClient } = await buildService("886912345678");
    svc.sessions.set("jid", makeWaState({ session: mockSession as unknown as AiSession, client: mockAiClient }));
    await svc.handleCommand("jid", "/clear", dummyMsg);
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
    await svc.handleCommand("jid", "/project", dummyMsg);
    const msg = vi.mocked(svc.wa.sendMessage).mock.calls[0]?.[1] as string;
    expect(msg).toContain("foo");
    expect(msg).toContain("bar");
  });

  it("/silent toggles silent mode on", async () => {
    const { svc } = await buildService("886912345678");
    const state = svc.getOrCreateState("jid");
    expect(state.silentMode).toBe(false);
    await svc.handleCommand("jid", "/silent", dummyMsg);
    expect(state.silentMode).toBe(true);
    const msg = vi.mocked(svc.wa.sendMessage).mock.calls[0]?.[1] as string;
    expect(msg).toContain("已開啟");
  });

  it("/silent toggles silent mode off when already on", async () => {
    const { svc } = await buildService("886912345678");
    svc.sessions.set("jid", makeWaState({ silentMode: true }));
    await svc.handleCommand("jid", "/silent", dummyMsg);
    const state = svc.sessions.get("jid")!;
    expect(state.silentMode).toBe(false);
    const msg = vi.mocked(svc.wa.sendMessage).mock.calls[0]?.[1] as string;
    expect(msg).toContain("已關閉");
  });

  it("/allowall toggles allowAll flag", async () => {
    const { svc } = await buildService("886912345678");
    const state = svc.getOrCreateState("jid");
    expect(state.allowAll).toBe(false);
    await svc.handleCommand("jid", "/allowall", dummyMsg);
    expect(state.allowAll).toBe(true);
    const msg = vi.mocked(svc.wa.sendMessage).mock.calls[0]?.[1] as string;
    expect(msg).toContain("已開啟");
  });

  it("unknown command shows help hint", async () => {
    const { svc } = await buildService("886912345678");
    await svc.handleCommand("jid", "/unknown", dummyMsg);
    const msg = vi.mocked(svc.wa.sendMessage).mock.calls[0]?.[1] as string;
    expect(msg).toContain("未知命令");
    expect(msg).toContain("/help");
  });
});

describe("AI event handling", () => {
  beforeEach(() => { vi.clearAllMocks(); mockSendMessage.mockResolvedValue({ id: "mock-id", remoteJid: "jid@s.whatsapp.net", fromMe: true }); });

  it("assistant.message sends formatted reply and stores it", async () => {
    const { svc } = await buildService("886912345678");
    svc.sessions.set("jid", makeWaState({ processing: true, lastPrompt: "q" }));

    await svc.handleAiEvent("jid", { type: "assistant.message", data: { content: "Hello AI" } });

    expect(svc.wa.sendMessage).toHaveBeenCalledWith("jid", "Hello AI");
    const state = svc.sessions.get("jid")!;
    expect(state.lastReply).toBe("Hello AI");
  });

  it("assistant.message sends available presence after reply", async () => {
    const { svc } = await buildService("886912345678");
    svc.sessions.set("jid", makeWaState({ processing: true, lastPrompt: "q" }));
    await svc.handleAiEvent("jid", { type: "assistant.message", data: { content: "Reply" } });
    expect(svc.wa.sendPresenceUpdate).toHaveBeenCalledWith("jid", "available");
  });

  it("assistant.message handles text field fallback", async () => {
    const { svc } = await buildService("886912345678");
    svc.sessions.set("jid", makeWaState({ processing: true, lastPrompt: "q" }));
    await svc.handleAiEvent("jid", { type: "assistant.message", data: { text: "text fallback" } });
    expect(svc.wa.sendMessage).toHaveBeenCalledWith("jid", "text fallback");
  });

  it("assistant.message_delta sends commentary progress in normal mode", async () => {
    const { svc } = await buildService("886912345678");
    svc.sessions.set("jid", makeWaState({ processing: true, lastPrompt: "q", silentMode: false }));

    await svc.handleAiEvent("jid", {
      type: "assistant.message_delta",
      data: { content: "我先確認今天的格式", phase: "commentary" }
    });

    expect(svc.wa.sendMessage).toHaveBeenCalledWith("jid", "我先確認今天的格式");
  });

  it("session.idle clears processing and persists memory", async () => {
    const { svc } = await buildService("886912345678");
    svc.sessions.set("jid", makeWaState({ processing: true, lastPrompt: "question", lastReply: "answer" }));

    await svc.handleAiEvent("jid", { type: "session.idle", data: {} });

    const state = svc.sessions.get("jid")!;
    expect(state.processing).toBe(false);
    expect(state.lastPrompt).toBeUndefined();
    expect(state.lastReply).toBeUndefined();
    expect(svc.sessionMemory.append).toHaveBeenCalledTimes(2);
  });

  it("session.idle sends available presence update", async () => {
    const { svc } = await buildService("886912345678");
    svc.sessions.set("jid", makeWaState({ processing: true }));
    await svc.handleAiEvent("jid", { type: "session.idle", data: {} });
    expect(svc.wa.sendPresenceUpdate).toHaveBeenCalledWith("jid", "available");
  });

  it("session.idle processes next queued task", async () => {
    const { svc } = await buildService("886912345678");
    const spyProcess = vi.spyOn(svc, "processPrompt").mockResolvedValue(undefined);

    const nextTask = makeTask("next msg");
    svc.sessions.set("jid", makeWaState({
      processing: true,
      pendingTasks: [nextTask],
      lastPrompt: "done",
      lastReply: "done",
    }));

    await svc.handleAiEvent("jid", { type: "session.idle", data: {} });
    await new Promise((r) => setTimeout(r, 0)); // flush microtasks

    expect(spyProcess).toHaveBeenCalledWith("jid", nextTask);
  });

  it("long response is split into ≤4000 char chunks", async () => {
    const { splitLongMessage } = await import("../src/whatsapp/markdown.js");
    const longText = "x".repeat(9000);
    vi.mocked(splitLongMessage).mockReturnValueOnce(["x".repeat(4000), "x".repeat(4000), "x".repeat(1000)]);

    const { svc } = await buildService("886912345678");
    svc.sessions.set("jid", makeWaState({ processing: true, lastPrompt: "q" }));

    await svc.handleAiEvent("jid", { type: "assistant.message", data: { content: longText } });

    const calls = vi.mocked(svc.wa.sendMessage).mock.calls;
    expect(calls.length).toBe(3);
    for (const [, text] of calls) {
      expect((text as string).length).toBeLessThanOrEqual(4000);
    }
  });
});

describe("Tool event handling", () => {
  beforeEach(() => { vi.clearAllMocks(); mockSendMessage.mockResolvedValue({ id: "tool-msg-id", remoteJid: "jid@s.whatsapp.net", fromMe: true }); });

  it("tool.execution_start sends tool notification", async () => {
    const { svc } = await buildService("886912345678");
    svc.sessions.set("jid", makeWaState({ processing: true }));

    await svc.handleAiEvent("jid", {
      type: "tool.execution_start",
      data: { toolName: "ReadFile", toolCallId: "call-1", args: { path: "/tmp/foo" } },
    });

    const msg = vi.mocked(svc.wa.sendMessage).mock.calls[0]?.[1] as string;
    expect(msg).toContain("ReadFile");
    const state = svc.sessions.get("jid")!;
    expect(state.toolMessageMap.has("call-1")).toBe(true);
  });

  it("tool.execution_start stores tracking with message key", async () => {
    const { svc } = await buildService("886912345678");
    svc.sessions.set("jid", makeWaState({ processing: true }));

    await svc.handleAiEvent("jid", {
      type: "tool.execution_start",
      data: { toolName: "WriteFile", toolCallId: "call-2", args: {} },
    });

    const state = svc.sessions.get("jid")!;
    const tracking = state.toolMessageMap.get("call-2");
    expect(tracking).toBeDefined();
    expect(tracking!.toolName).toBe("WriteFile");
    expect(tracking!.msgKey).toEqual({ id: "tool-msg-id", remoteJid: "jid@s.whatsapp.net", fromMe: true });
  });

  it("tool.execution_complete sends reaction and result message", async () => {
    const { svc } = await buildService("886912345678");
    const toolMap = new Map<string, import("../src/whatsapp/service.js").WaToolTracking>();
    toolMap.set("call-3", {
      toolName: "BashTool",
      callId: "call-3",
      msgKey: { id: "tool-msg-id", remoteJid: "jid@s.whatsapp.net", fromMe: true },
      startTime: Date.now(),
    });
    svc.sessions.set("jid", makeWaState({ processing: true, toolMessageMap: toolMap }));

    await svc.handleAiEvent("jid", {
      type: "tool.execution_complete",
      data: { toolCallId: "call-3", result: "success output" },
    });

    // Should react with ✅ to the tool start message
    expect(svc.wa.sendReaction).toHaveBeenCalledWith(
      "jid",
      { id: "tool-msg-id", remoteJid: "jid@s.whatsapp.net", fromMe: true },
      "✅",
    );

    // Should send complete message
    const calls = vi.mocked(svc.wa.sendMessage).mock.calls;
    const completeMsg = calls.find(([, t]) => (t as string).includes("完成"));
    expect(completeMsg).toBeDefined();

    // Tracking cleaned up
    const state = svc.sessions.get("jid")!;
    expect(state.toolMessageMap.has("call-3")).toBe(false);
  });

  it("tool.execution_complete reacts with ❌ on error", async () => {
    const { svc } = await buildService("886912345678");
    const toolMap = new Map<string, import("../src/whatsapp/service.js").WaToolTracking>();
    toolMap.set("call-err", {
      toolName: "FailTool",
      callId: "call-err",
      msgKey: { id: "tool-err-id", remoteJid: "jid@s.whatsapp.net", fromMe: true },
      startTime: Date.now(),
    });
    svc.sessions.set("jid", makeWaState({ processing: true, toolMessageMap: toolMap }));

    await svc.handleAiEvent("jid", {
      type: "tool.execution_complete",
      data: { toolCallId: "call-err", error: "command failed" },
    });

    expect(svc.wa.sendReaction).toHaveBeenCalledWith(
      "jid",
      { id: "tool-err-id", remoteJid: "jid@s.whatsapp.net", fromMe: true },
      "❌",
    );
  });

  it("tool.execution_start in silent mode still stores tracking", async () => {
    const { svc } = await buildService("886912345678");
    svc.sessions.set("jid", makeWaState({ processing: true, silentMode: true }));

    await svc.handleAiEvent("jid", {
      type: "tool.execution_start",
      data: { toolName: "SilentTool", toolCallId: "call-silent", args: {} },
    });

    const state = svc.sessions.get("jid")!;
    expect(state.toolMessageMap.has("call-silent")).toBe(true);
    // Still sends a condensed message even in silent mode
    expect(svc.wa.sendMessage).toHaveBeenCalled();
  });

  it("tool.execution_complete in silent mode does NOT send reaction", async () => {
    const { svc } = await buildService("886912345678");
    const toolMap = new Map<string, import("../src/whatsapp/service.js").WaToolTracking>();
    toolMap.set("call-s", {
      toolName: "SilentTool",
      callId: "call-s",
      msgKey: { id: "s-id", remoteJid: "jid@s.whatsapp.net", fromMe: true },
      startTime: Date.now(),
    });
    svc.sessions.set("jid", makeWaState({ processing: true, silentMode: true, toolMessageMap: toolMap }));

    await svc.handleAiEvent("jid", {
      type: "tool.execution_complete",
      data: { toolCallId: "call-s", result: "ok" },
    });

    // In silent mode, no reaction and no complete message
    expect(svc.wa.sendReaction).not.toHaveBeenCalled();
    expect(svc.wa.sendMessage).not.toHaveBeenCalled();
  });
});

describe("Quoted message context", () => {
  beforeEach(() => { vi.clearAllMocks(); mockSendMessage.mockResolvedValue({ id: "mock-id", remoteJid: "jid@s.whatsapp.net", fromMe: true }); });

  it("prepends quoted text as context when message has quotedText", async () => {
    const { svc, mockSession } = await buildService("886912345678");
    const jid = "886912345678@s.whatsapp.net";

    // Pre-create session so processPrompt goes straight to session.send
    svc.sessions.set(jid, makeWaState({
      session: mockSession as unknown as AiSession,
      workDir: "/tmp/project",
    }));

    await svc.handleMessage({
      id: "q1",
      from: jid,
      content: "請解釋這段話",
      timestamp: 1,
      isGroup: false,
      messageKey: { id: "q1", remoteJid: jid, fromMe: true },
      quotedText: "previous message content",
    });

    // session.send should have been called with the quoted context prepended
    expect(mockSession.send).toHaveBeenCalledWith(
      "> [引用] previous message content\n\n請解釋這段話",
      undefined,
    );
  });

  it("passes plain prompt without modification when no quotedText", async () => {
    const { svc, mockSession } = await buildService("886912345678");
    const jid = "886912345678@s.whatsapp.net";

    svc.sessions.set(jid, makeWaState({
      session: mockSession as unknown as AiSession,
      workDir: "/tmp/project",
    }));

    await svc.handleMessage({
      id: "q2",
      from: jid,
      content: "ordinary message",
      timestamp: 2,
      isGroup: false,
      messageKey: { id: "q2", remoteJid: jid, fromMe: true },
    });

    expect(mockSession.send).toHaveBeenCalledWith("ordinary message", undefined);
  });
});

describe("Session lifecycle", () => {
  beforeEach(() => { vi.clearAllMocks(); mockSendMessage.mockResolvedValue({ id: "mock-id", remoteJid: "jid@s.whatsapp.net", fromMe: true }); });

  it("fresh session passes expiry check without rebuild notification", async () => {
    const ownerJid = "886912345678@s.whatsapp.net";
    const { svc, mockSession, mockAiClient } = await buildService("886912345678");
    svc.sessions.set(ownerJid, makeWaState({
      session: mockSession as unknown as AiSession,
      client: mockAiClient,
      sessionCreatedAt: Date.now(),
      sessionLastActivityAt: Date.now(),
    }));

    const spyProcess = vi.spyOn(svc, "processPrompt");
    await svc.handleMessage({ id: "1", from: ownerJid, content: "test", timestamp: 1, isGroup: false, messageKey: { id: "1", remoteJid: ownerJid, fromMe: true } });

    // Should NOT send rebuild notification
    const calls = vi.mocked(svc.wa.sendMessage).mock.calls;
    expect(calls.some(([, t]) => (t as string).includes("重建"))).toBe(false);
    expect(spyProcess).toHaveBeenCalled();
  });

  it("expired session triggers rebuild on processPrompt", async () => {
    const { svc, mockSession, mockAiClient } = await buildService("886912345678");
    // Session created 11 hours ago (past 10h limit)
    svc.sessions.set("jid", makeWaState({
      session: mockSession as unknown as AiSession,
      client: mockAiClient,
      sessionCreatedAt: Date.now() - 11 * 60 * 60 * 1000,
      sessionLastActivityAt: Date.now() - 11 * 60 * 60 * 1000,
    }));

    await svc.processPrompt("jid", makeTask("test"));

    const calls = vi.mocked(svc.wa.sendMessage).mock.calls;
    expect(calls.some(([, t]) => (t as string).includes("重建"))).toBe(true);
  });

  it("idle session triggers rebuild on processPrompt", async () => {
    const { svc, mockSession, mockAiClient } = await buildService("886912345678");
    // Last activity 2 hours ago (past 1h idle limit)
    svc.sessions.set("jid", makeWaState({
      session: mockSession as unknown as AiSession,
      client: mockAiClient,
      sessionCreatedAt: Date.now() - 2 * 60 * 60 * 1000,
      sessionLastActivityAt: Date.now() - 2 * 60 * 60 * 1000,
    }));

    await svc.processPrompt("jid", makeTask("test"));

    const calls = vi.mocked(svc.wa.sendMessage).mock.calls;
    expect(calls.some(([, t]) => (t as string).includes("重建"))).toBe(true);
  });

  it("promptCycles increments on each processPrompt", async () => {
    const { svc } = await buildService("886912345678");
    svc.sessions.set("jid", makeWaState({ promptCycles: 5 }));

    // processPrompt calls ensureSession which fails without workDir config
    // but cycles should still increment
    await svc.processPrompt("jid", makeTask("test")).catch(() => undefined);

    const state = svc.sessions.get("jid")!;
    // promptCycles increments before send
    expect(state.promptCycles).toBeGreaterThanOrEqual(6);
  });
});
