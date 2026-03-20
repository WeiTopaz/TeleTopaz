import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeSdkSession } from "../src/claude/sdk.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({
    stdout: { on: vi.fn(), setEncoding: vi.fn() },
    stderr: { on: vi.fn(), setEncoding: vi.fn() },
    stdin: { end: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
    pid: 12345
  }))
}));

describe("ClaudeCodeSdkSession", () => {
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
      stdin: { end: vi.fn() },
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

  it("passes Claude home access settings to the CLI", async () => {
    const mockChild = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mockChild.child as ReturnType<typeof spawn>);
    const session = new ClaudeCodeSdkSession({
      model: "claude-sonnet-4.6",
      approvalMode: "plan",
      workingDirectory: "/tmp/project"
    });

    const promise = (session as unknown as {
      spawnClaudeCodeCli: (prompt: string, signal: AbortSignal) => Promise<string>;
    }).spawnClaudeCodeCli("請讀取 Claude 設定", new AbortController().signal);

    mockChild.emitClose(0);
    await expect(promise).resolves.toBe("");

    const args = vi.mocked(spawn).mock.calls.at(-1)?.[1];
    expect(args).toEqual(expect.arrayContaining([
      "--permission-mode",
      "plan",
      "--add-dir",
      path.join(os.homedir(), ".claude"),
      "--settings"
    ]));

    const settingsIndex = args?.indexOf("--settings") ?? -1;
    expect(settingsIndex).toBeGreaterThan(-1);

    const rawSettings = settingsIndex >= 0 ? args?.[settingsIndex + 1] : undefined;
    expect(typeof rawSettings).toBe("string");

    const settings = JSON.parse(String(rawSettings)) as {
      permissions?: {
        allow?: string[];
        additionalDirectories?: string[];
      };
    };

    expect(settings.permissions?.additionalDirectories).toEqual(
      expect.arrayContaining(["~/.claude", "/tmp/project"])
    );
    expect(settings.permissions?.allow).toEqual(
      expect.arrayContaining([
        "Read(~/.claude/**)",
        "Read(~/.claude.json)",
        "Edit(~/.claude/**)",
        "Edit(~/.claude.json)"
      ])
    );
  });

  it("maps auto_edit approval mode to acceptEdits for the CLI", async () => {
    const mockChild = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mockChild.child as ReturnType<typeof spawn>);
    const session = new ClaudeCodeSdkSession({
      model: "claude-sonnet-4.6",
      approvalMode: "auto_edit",
      workingDirectory: "/tmp/project"
    });

    const promise = (session as unknown as {
      spawnClaudeCodeCli: (prompt: string, signal: AbortSignal) => Promise<string>;
    }).spawnClaudeCodeCli("請直接修改設定", new AbortController().signal);

    mockChild.emitClose(0);
    await expect(promise).resolves.toBe("");

    const args = vi.mocked(spawn).mock.calls.at(-1)?.[1];
    expect(args).toEqual(expect.arrayContaining([
      "--permission-mode",
      "acceptEdits"
    ]));
  });
});
