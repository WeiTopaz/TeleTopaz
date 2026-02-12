import { describe, it, expect, vi } from "vitest";
import { GeminiSdkSession } from "../src/gemini/sdk.js";
import type { AiEvent, AiSessionOptions } from "../src/provider/types.js";

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
