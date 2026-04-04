import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
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

vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn()
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

  it("passes Claude home access settings via a temp file path, not inline JSON", async () => {
    vi.mocked(writeFileSync).mockClear();
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

    // --settings 後面必須是檔案路徑，不是 inline JSON
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
    const rawSettings = args?.[settingsIndex + 1];

    // 必須是路徑格式（包含 teletopaz-claude-settings），不是 inline JSON
    expect(rawSettings).toMatch(/teletopaz-claude-settings-.*\.json$/);
    expect(() => JSON.parse(String(rawSettings))).toThrow(); // 路徑不是有效 JSON

    // writeFileSync 必須被呼叫，且寫入的是正確 settings 內容
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenContent] = vi.mocked(writeFileSync).mock.calls[0] as [string, string, string];
    expect(writtenPath).toBe(rawSettings); // 路徑一致

    const settings = JSON.parse(writtenContent) as {
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

  it("cleans up the temp settings file after the child process closes", async () => {
    vi.mocked(writeFileSync).mockClear();
    vi.mocked(unlinkSync).mockClear();
    const mockChild = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mockChild.child as ReturnType<typeof spawn>);
    const session = new ClaudeCodeSdkSession({
      model: "claude-sonnet-4.6",
      approvalMode: "plan",
      workingDirectory: "/tmp/project"
    });

    const promise = (session as unknown as {
      spawnClaudeCodeCli: (prompt: string, signal: AbortSignal) => Promise<string>;
    }).spawnClaudeCodeCli("test", new AbortController().signal);

    mockChild.emitClose(0);
    await promise;

    // temp 檔必須在 close 後被清除
    const [writtenPath] = vi.mocked(writeFileSync).mock.calls[0] as [string, string, string];
    expect(vi.mocked(unlinkSync)).toHaveBeenCalledWith(writtenPath);
  });

  it("maps auto_edit approval mode to acceptEdits for the CLI", async () => {
    vi.mocked(writeFileSync).mockClear();
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
