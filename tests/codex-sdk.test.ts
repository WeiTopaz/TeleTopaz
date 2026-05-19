import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { CodexSdkSession, isRetryableError, resolveCodexCliTimeoutMs } from "../src/codex/sdk.js";
import type { AiEvent } from "../src/provider/types.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({
    stdout: { on: vi.fn(), setEncoding: vi.fn(), destroy: vi.fn() },
    stderr: { on: vi.fn(), setEncoding: vi.fn(), destroy: vi.fn() },
    stdin: { end: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
    killed: false,
    pid: 12345
  }))
}));

function createMockChild() {
  const stdoutHandlers: Array<(chunk: string) => void> = [];
  const stderrHandlers: Array<(chunk: string) => void> = [];
  const closeHandlers: Array<(code: number | null) => void> = [];
  const errorHandlers: Array<(err: Error) => void> = [];

  const child = {
    stdout: {
      on: vi.fn((event: string, handler: (chunk: string) => void) => {
        if (event === "data") stdoutHandlers.push(handler);
      }),
      setEncoding: vi.fn(),
      destroy: vi.fn()
    },
    stderr: {
      on: vi.fn((event: string, handler: (chunk: string) => void) => {
        if (event === "data") stderrHandlers.push(handler);
      }),
      setEncoding: vi.fn(),
      destroy: vi.fn()
    },
    stdin: { end: vi.fn() },
    on: vi.fn((event: string, handler: (value: unknown) => void) => {
      if (event === "close") closeHandlers.push(handler as (code: number | null) => void);
      if (event === "error") errorHandlers.push(handler as (err: Error) => void);
    }),
    kill: vi.fn(),
    killed: false,
    pid: 12345
  };

  return {
    child,
    emitStdout(chunk: string) {
      stdoutHandlers.forEach((h) => h(chunk));
    },
    emitStderr(chunk: string) {
      stderrHandlers.forEach((h) => h(chunk));
    },
    emitClose(code: number | null = 0) {
      closeHandlers.forEach((h) => h(code));
    },
    emitError(err: Error) {
      errorHandlers.forEach((h) => h(err));
    }
  };
}

describe("codex isRetryableError", () => {
  it("returns false for the local CLI timeout (prevents re-waiting another 5 minutes)", () => {
    // 本地 CLI timeout 表示 agent 卡死，不是網路暫態，不應該重試
    expect(isRetryableError(new Error("timeout: Codex CLI exceeded 300000ms"))).toBe(false);
  });

  it("still returns true for network-level transient errors", () => {
    expect(isRetryableError(new Error("GOAWAY received"))).toBe(true);
    expect(isRetryableError(new Error("connection reset by peer"))).toBe(true);
    expect(isRetryableError(new Error("connection refused"))).toBe(true);
    expect(isRetryableError(new Error("ETIMEDOUT: connect timeout"))).toBe(true);
    expect(isRetryableError(new Error("socket timeout"))).toBe(true);
    expect(isRetryableError(new Error("overloaded"))).toBe(true);
  });

  it("returns false for null or unrelated errors", () => {
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(new Error("command not found: codex"))).toBe(false);
  });

  it("uses a longer Codex CLI timeout by default and accepts positive env overrides", () => {
    expect(resolveCodexCliTimeoutMs({})).toBe(1_800_000);
    expect(resolveCodexCliTimeoutMs({ TELETOPAZ_CODEX_CLI_TIMEOUT_MS: "1200000" })).toBe(1_200_000);
    expect(resolveCodexCliTimeoutMs({ TELETOPAZ_CODEX_CLI_TIMEOUT_MS: "nope" })).toBe(1_800_000);
  });
});

describe("CodexSdkSession abort cleanup", () => {
  const originalSandboxEnv = process.env["TELETOPAZ_SANDBOX_ACTIVE"];
  const originalCodexTimeoutEnv = process.env["TELETOPAZ_CODEX_CLI_TIMEOUT_MS"];

  beforeEach(() => {
    vi.mocked(spawn).mockClear();
    if (originalSandboxEnv === undefined) {
      delete process.env["TELETOPAZ_SANDBOX_ACTIVE"];
    } else {
      process.env["TELETOPAZ_SANDBOX_ACTIVE"] = originalSandboxEnv;
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalSandboxEnv === undefined) {
      delete process.env["TELETOPAZ_SANDBOX_ACTIVE"];
    } else {
      process.env["TELETOPAZ_SANDBOX_ACTIVE"] = originalSandboxEnv;
    }
    if (originalCodexTimeoutEnv === undefined) {
      delete process.env["TELETOPAZ_CODEX_CLI_TIMEOUT_MS"];
    } else {
      process.env["TELETOPAZ_CODEX_CLI_TIMEOUT_MS"] = originalCodexTimeoutEnv;
    }
  });

  it("destroys stdio pipes when aborted to stop residual event emission", async () => {
    const mock = createMockChild();
    vi.mocked(spawn).mockReturnValueOnce(mock.child as unknown as ReturnType<typeof spawn>);

    const session = new CodexSdkSession({
      model: "gpt-5.4-mini",
      workingDirectory: "/tmp",
      approvalMode: "yolo"
    });

    const events: AiEvent[] = [];
    session.onEvent((e) => events.push(e));

    const sendPromise = session.send("test");
    // allow microtasks to advance so spawn is invoked
    await Promise.resolve(); await Promise.resolve();

    await session.abort();
    await Promise.resolve(); await Promise.resolve();

    expect(mock.child.stdout.destroy).toHaveBeenCalled();
    expect(mock.child.stderr.destroy).toHaveBeenCalled();
    expect(mock.child.kill).toHaveBeenCalledWith("SIGTERM");

    // Simulate late stdout after abort — must not reach event handler any more.
    // (We still call emitStdout to prove the pipe-destroyed path — handlers fire but
    //  the Promise is already resolved/aborted, so no late emit to session.)
    mock.emitStdout(JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "late message" }
    }) + "\n");
    mock.emitClose(143);
    await Promise.resolve(); await Promise.resolve();
    await sendPromise;

    const lateAssistant = events.find(
      (e) => e.type === "assistant.message" && ((e.data as { content?: string })?.content === "late message")
    );
    expect(lateAssistant).toBeUndefined();
  });

  it("spawns codex with user config and rules disabled so global plugins cannot hijack bot turns", async () => {
    const mock = createMockChild();
    vi.mocked(spawn).mockReturnValueOnce(mock.child as unknown as ReturnType<typeof spawn>);

    const session = new CodexSdkSession({
      model: "gpt-5.4-mini",
      workingDirectory: "/tmp",
      approvalMode: "auto_edit",
      systemPrompt: "system prompt"
    });

    const sendPromise = session.send("只回覆 ok");
    await Promise.resolve();
    await Promise.resolve();

    const spawnCall = vi.mocked(spawn).mock.calls[0];
    expect(spawnCall).toBeDefined();
    const args = spawnCall?.[1] as string[] | undefined;
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ignore-rules");

    mock.emitStdout(JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "ok" }
    }) + "\n");
    mock.emitClose(0);
    await sendPromise;
  });

  it("uses Codex bypass mode when TeleTopaz sandbox is already active", async () => {
    process.env["TELETOPAZ_SANDBOX_ACTIVE"] = "1";

    const mock = createMockChild();
    vi.mocked(spawn).mockReturnValueOnce(mock.child as unknown as ReturnType<typeof spawn>);

    const session = new CodexSdkSession({
      model: "gpt-5.4-mini",
      workingDirectory: "/tmp",
      approvalMode: "yolo"
    });

    const sendPromise = session.send("只回覆 ok");
    await Promise.resolve();
    await Promise.resolve();

    const spawnCall = vi.mocked(spawn).mock.calls[0];
    expect(spawnCall).toBeDefined();
    const args = spawnCall?.[1] as string[] | undefined;
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("--full-auto");

    mock.emitStdout(JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "ok" }
    }) + "\n");
    mock.emitClose(0);
    await sendPromise;
  });

  it("does not bypass approvals and sandbox for auto_edit mode inside TeleTopaz sandbox", async () => {
    process.env["TELETOPAZ_SANDBOX_ACTIVE"] = "1";

    const mock = createMockChild();
    vi.mocked(spawn).mockReturnValueOnce(mock.child as unknown as ReturnType<typeof spawn>);

    const session = new CodexSdkSession({
      model: "gpt-5.4-mini",
      workingDirectory: "/tmp",
      approvalMode: "auto_edit"
    });

    const sendPromise = session.send("只回覆 ok");
    await Promise.resolve();
    await Promise.resolve();

    const spawnCall = vi.mocked(spawn).mock.calls[0];
    expect(spawnCall).toBeDefined();
    const args = spawnCall?.[1] as string[] | undefined;
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("--full-auto");
    expect(args).toEqual(expect.arrayContaining(["--sandbox", "workspace-write"]));

    mock.emitStdout(JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "ok" }
    }) + "\n");
    mock.emitClose(0);
    await sendPromise;
  });

  it("finishes shortly after turn.completed even if the codex process does not close", async () => {
    vi.useFakeTimers();
    const mock = createMockChild();
    vi.mocked(spawn).mockReturnValueOnce(mock.child as unknown as ReturnType<typeof spawn>);

    const session = new CodexSdkSession({
      model: "gpt-5.4-mini",
      workingDirectory: "/tmp",
      approvalMode: "auto_edit"
    });

    const events: AiEvent[] = [];
    session.onEvent((event) => events.push(event));

    let settled = false;
    const sendPromise = session.send("只回覆 ok").then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    mock.emitStdout(JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "ok" }
    }) + "\n");
    mock.emitStdout(JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 1, output_tokens: 1 }
    }) + "\n");
    await Promise.resolve();
    await Promise.resolve();

    try {
      await vi.advanceTimersByTimeAsync(59_000);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(true);
      expect(events).toContainEqual({
        type: "assistant.message",
        data: { content: "ok" }
      });
      expect(events).toContainEqual({ type: "session.idle" });
    } finally {
      await session.abort();
      await Promise.resolve();
      await Promise.resolve();
      await sendPromise;
    }
  });

  it("honors the Codex CLI timeout env override", async () => {
    vi.useFakeTimers();
    process.env["TELETOPAZ_CODEX_CLI_TIMEOUT_MS"] = "1000";
    const mock = createMockChild();
    vi.mocked(spawn).mockReturnValueOnce(mock.child as unknown as ReturnType<typeof spawn>);

    const session = new CodexSdkSession({
      model: "gpt-5.4-mini",
      workingDirectory: "/tmp",
      approvalMode: "auto_edit"
    });

    const events: AiEvent[] = [];
    session.onEvent((event) => events.push(event));

    const sendPromise = session.send("test");
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(999);
    expect(mock.child.kill).not.toHaveBeenCalled();
    expect(events).not.toContainEqual(expect.objectContaining({
      type: "assistant.message",
      data: expect.objectContaining({ content: expect.stringContaining("Codex CLI exceeded") })
    }));

    await vi.advanceTimersByTimeAsync(1);
    await sendPromise;

    expect(mock.child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(events).toContainEqual(expect.objectContaining({
      type: "assistant.message",
      data: expect.objectContaining({ content: expect.stringContaining("1000ms") })
    }));
    expect(events).toContainEqual({ type: "session.idle" });
  });

  it("parses commentary and function-call events from current Codex JSON output", () => {
    const session = new CodexSdkSession({
      model: "gpt-5.4-mini",
      workingDirectory: "/tmp",
      approvalMode: "auto_edit"
    });

    const events: AiEvent[] = [];
    session.onEvent((event) => events.push(event));

    (session as unknown as { handleStreamEvent: (event: Record<string, unknown>) => void }).handleStreamEvent({
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "我先看檔案",
        phase: "commentary"
      }
    });

    (session as unknown as { handleStreamEvent: (event: Record<string, unknown>) => void }).handleStreamEvent({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call-1",
        arguments: "{\"cmd\":\"pwd\"}"
      }
    });

    (session as unknown as { handleStreamEvent: (event: Record<string, unknown>) => void }).handleStreamEvent({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-1",
        output: "sandbox-exec: sandbox_apply: Operation not permitted"
      }
    });

    expect(events).toContainEqual({
      type: "assistant.message_delta",
      data: { content: "我先看檔案", phase: "commentary" }
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool.execution_start",
      data: expect.objectContaining({
        toolName: "exec_command",
        toolCallId: "call-1",
        toolArgs: { cmd: "pwd" }
      })
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool.execution_complete",
      data: expect.objectContaining({
        toolCallId: "call-1",
        status: "success",
        output: "sandbox-exec: sandbox_apply: Operation not permitted"
      })
    }));
  });
});
