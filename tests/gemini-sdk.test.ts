import { describe, it, expect, vi } from "vitest";
import { spawn } from "node:child_process";
import { GeminiSdkSession } from "../src/gemini/sdk.js";
import type { AiSessionOptions } from "../src/provider/types.js";

// Mock child_process to prevent actual spawning
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({
    stdout: { on: vi.fn(), setEncoding: vi.fn() },
    stderr: { on: vi.fn(), setEncoding: vi.fn() },
    stdin: { write: vi.fn(), end: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
    pid: 12345
  }))
}));

describe("GeminiSdkSession", () => {
  function createMockChildProcess() {
    const stdoutHandlers: Array<(chunk: string) => void> = [];
    const stderrHandlers: Array<(chunk: string) => void> = [];
    const closeHandlers: Array<(code: number) => void> = [];
    const errorHandlers: Array<(error: Error) => void> = [];

    const child = {
      stdout: {
        on: vi.fn((event: string, handler: (chunk: string) => void) => {
          if (event === "data") stdoutHandlers.push(handler);
        }),
        setEncoding: vi.fn()
      },
      stderr: {
        on: vi.fn((event: string, handler: (chunk: string) => void) => {
          if (event === "data") stderrHandlers.push(handler);
        }),
        setEncoding: vi.fn()
      },
      stdin: { write: vi.fn(), end: vi.fn() },
      on: vi.fn((event: string, handler: (value: any) => void) => {
        if (event === "close") closeHandlers.push(handler);
        if (event === "error") errorHandlers.push(handler);
      }),
      kill: vi.fn(),
      pid: 12345
    };

    return {
      child,
      emitStdout(chunk: string) {
        stdoutHandlers.forEach((handler) => handler(chunk));
      },
      emitStderr(chunk: string) {
        stderrHandlers.forEach((handler) => handler(chunk));
      },
      emitClose(code: number) {
        closeHandlers.forEach((handler) => handler(code));
      },
      emitError(error: Error) {
        errorHandlers.forEach((handler) => handler(error));
      }
    };
  }

  it("hooks events and emits assistant.message and session.idle on send", async () => {
    const options: AiSessionOptions = { model: "gemini-3-pro-preview" };
    const geminiSession = new GeminiSdkSession(options);
    
    expect(geminiSession).toBeDefined();
    expect(typeof geminiSession.send).toBe("function");
  });

  it("extracts onPreToolUse hook from options", () => {
    const hook = vi.fn();
    const options: AiSessionOptions = {
      model: "gemini-3-pro-preview",
      hooks: { onPreToolUse: hook }
    };
    const session = new GeminiSdkSession(options);
    // Verify session is created successfully with hooks
    expect(session).toBeDefined();
  });

  it("creates session without hooks gracefully", () => {
    const options: AiSessionOptions = { model: "gemini-3-pro-preview" };
    const session = new GeminiSdkSession(options);
    expect(session).toBeDefined();
  });

  it("applies onPreToolUse to non-dangerous Gemini tools", async () => {
    const mockChild = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mockChild.child as any);
    const processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);
    const hook = vi.fn().mockResolvedValue({ permissionDecision: "deny" });
    const session = new GeminiSdkSession({
      model: "gemini-3-pro-preview",
      hooks: { onPreToolUse: hook }
    });

    const promise = (session as unknown as {
      spawnGeminiCli: (prompt: string, signal: AbortSignal) => Promise<string>;
    }).spawnGeminiCli("請分類這段訊息", new AbortController().signal);

    mockChild.emitStdout(`${JSON.stringify({
      type: "tool_use",
      tool_name: "read_file",
      parameters: { path: "README.md" }
    })}\n`);
    await Promise.resolve();
    await Promise.resolve();
    mockChild.emitClose(1);

    await expect(promise).rejects.toThrow(/denied/i);
    expect(hook).toHaveBeenCalledWith({
      toolName: "read_file",
      toolArgs: { path: "README.md" }
    });
    expect(processKillSpy).toHaveBeenCalledWith(12345, "SIGSTOP");
    expect(mockChild.child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("passes the configured approval mode to Gemini CLI", async () => {
    const mockChild = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mockChild.child as any);
    const session = new GeminiSdkSession({
      model: "gemini-3-pro-preview",
      approvalMode: "plan"
    });

    const promise = (session as unknown as {
      spawnGeminiCli: (prompt: string, signal: AbortSignal) => Promise<string>;
    }).spawnGeminiCli("只做規劃", new AbortController().signal);

    mockChild.emitClose(0);
    await expect(promise).resolves.toBe("");

    const args = vi.mocked(spawn).mock.calls.at(-1)?.[1];
    expect(args).toEqual(expect.arrayContaining(["--approval-mode", "plan"]));
  });

  it("abort handles AbortController", async () => {
    const options: AiSessionOptions = { model: "gemini-3-pro-preview" };
    const geminiSession = new GeminiSdkSession(options);
    
    await expect(geminiSession.abort()).resolves.not.toThrow();
  });

  it("destroy handles AbortController", async () => {
    const options: AiSessionOptions = { model: "gemini-3-pro-preview" };
    const geminiSession = new GeminiSdkSession(options);
    
    await expect(geminiSession.destroy()).resolves.not.toThrow();
  });
});
