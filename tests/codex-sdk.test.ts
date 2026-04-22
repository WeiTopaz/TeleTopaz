import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { CodexSdkSession, isRetryableError } from "../src/codex/sdk.js";
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
});

describe("CodexSdkSession abort cleanup", () => {
  beforeEach(() => {
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("destroys stdio pipes when aborted to stop residual event emission", async () => {
    const mock = createMockChild();
    vi.mocked(spawn).mockReturnValueOnce(mock.child as unknown as ReturnType<typeof spawn>);

    const session = new CodexSdkSession({
      model: "gpt-5.4-mini",
      workingDirectory: "/tmp",
      approvalMode: "auto_edit"
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
});
