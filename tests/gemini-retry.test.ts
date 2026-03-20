import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { GeminiSdkSession } from "../src/gemini/sdk.js";
import type { AiEvent } from "../src/provider/types.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({
    stdout: { on: vi.fn(), setEncoding: vi.fn() },
    stderr: { on: vi.fn(), setEncoding: vi.fn() },
    stdin: { write: vi.fn(), end: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
    pid: 12345,
  })),
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
    },
    stderr: {
      on: vi.fn((event: string, handler: (chunk: string) => void) => {
        if (event === "data") stderrHandlers.push(handler);
      }),
      setEncoding: vi.fn(),
    },
    stdin: { write: vi.fn(), end: vi.fn() },
    on: vi.fn((event: string, handler: (value: any) => void) => {
      if (event === "close") closeHandlers.push(handler);
      if (event === "error") errorHandlers.push(handler);
    }),
    kill: vi.fn(),
    killed: false,
    pid: 12345,
  };

  return {
    child,
    emitOutput(text: string) {
      const line = JSON.stringify({ type: "message", role: "assistant", content: text });
      stdoutHandlers.forEach((h) => h(line + "\n"));
    },
    emitError(err: Error) {
      errorHandlers.forEach((h) => h(err));
    },
    emitClose(code: number | null = 0) {
      closeHandlers.forEach((h) => h(code));
    },
  };
}

describe("Gemini retry logic", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(spawn).mockClear();
  });

  it("retries on GOAWAY error with backoff and eventually succeeds", async () => {
    const failChild = createMockChild();
    const successChild = createMockChild();

    vi.mocked(spawn)
      .mockReturnValueOnce(failChild.child as any)
      .mockReturnValueOnce(successChild.child as any);

    const session = new GeminiSdkSession({ model: "gemini-pro", workingDirectory: "/tmp" });
    const events: AiEvent[] = [];
    session.onEvent((e) => events.push(e));

    const sendPromise = session.send("test prompt");

    // First spawn fails with GOAWAY
    await Promise.resolve(); await Promise.resolve();
    failChild.emitError(new Error("GOAWAY: connection closed"));
    await Promise.resolve(); await Promise.resolve();

    // Advance past 1s backoff
    await vi.advanceTimersByTimeAsync(1100);
    await Promise.resolve(); await Promise.resolve();

    // Second spawn succeeds
    successChild.emitOutput("Hello from AI");
    await Promise.resolve(); await Promise.resolve();
    successChild.emitClose(0);
    await Promise.resolve(); await Promise.resolve();

    await sendPromise;

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.type === "assistant.message" && (e.data as any)?.content === "Hello from AI")).toBe(true);
  });

  it("retries on connection reset error", async () => {
    const failChild = createMockChild();
    const successChild = createMockChild();

    vi.mocked(spawn)
      .mockReturnValueOnce(failChild.child as any)
      .mockReturnValueOnce(successChild.child as any);

    const session = new GeminiSdkSession({ model: "gemini-pro" });
    const events: AiEvent[] = [];
    session.onEvent((e) => events.push(e));

    const sendPromise = session.send("test");

    await Promise.resolve(); await Promise.resolve();
    failChild.emitError(new Error("connection reset by peer"));
    await Promise.resolve(); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1100);
    await Promise.resolve(); await Promise.resolve();

    successChild.emitOutput("Recovered");
    await Promise.resolve(); await Promise.resolve();
    successChild.emitClose(0);
    await Promise.resolve(); await Promise.resolve();

    await sendPromise;

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.type === "assistant.message" && (e.data as any)?.content === "Recovered")).toBe(true);
  });

  it("gives up after max retries (3 retries = 4 total spawn calls) and emits error message", async () => {
    // All 4 spawns fail with retryable errors
    const children = [createMockChild(), createMockChild(), createMockChild(), createMockChild()];
    let mockIdx = 0;
    vi.mocked(spawn).mockImplementation(() => children[mockIdx++]!.child as any);

    const session = new GeminiSdkSession({ model: "gemini-pro" });
    const events: AiEvent[] = [];
    session.onEvent((e) => events.push(e));

    const sendPromise = session.send("test");

    for (let i = 0; i < 4; i++) {
      await Promise.resolve(); await Promise.resolve();
      children[i]!.emitError(new Error("GOAWAY: retry needed"));
      await Promise.resolve(); await Promise.resolve();
      if (i < 3) {
        await vi.advanceTimersByTimeAsync(6000); // advance past backoff
      }
    }

    await sendPromise;

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(4);
    const errEvent = events.find((e) => e.type === "assistant.message");
    expect(errEvent).toBeDefined();
    expect((errEvent?.data as any)?.content).toContain("max retries");
  });

  it("does not retry on non-retryable errors", async () => {
    const failChild = createMockChild();
    vi.mocked(spawn).mockReturnValueOnce(failChild.child as any);

    const session = new GeminiSdkSession({ model: "gemini-pro" });
    const events: AiEvent[] = [];
    session.onEvent((e) => events.push(e));

    const sendPromise = session.send("test");

    await Promise.resolve(); await Promise.resolve();
    failChild.emitError(new Error("command not found: gemini"));
    await Promise.resolve(); await Promise.resolve();

    await sendPromise;

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    const errEvent = events.find((e) => e.type === "assistant.message");
    expect((errEvent?.data as any)?.content).toContain("command not found");
  });

  it("emits session.idle after successful response", async () => {
    const child = createMockChild();
    vi.mocked(spawn).mockReturnValueOnce(child.child as any);

    const session = new GeminiSdkSession({ model: "gemini-pro" });
    const events: AiEvent[] = [];
    session.onEvent((e) => events.push(e));

    const sendPromise = session.send("test");
    await Promise.resolve(); await Promise.resolve();
    child.emitOutput("Done");
    await Promise.resolve(); await Promise.resolve();
    child.emitClose(0);
    await Promise.resolve(); await Promise.resolve();

    await sendPromise;
    expect(events.some((e) => e.type === "session.idle")).toBe(true);
  });
});
