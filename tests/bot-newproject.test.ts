import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TeleTopazService } from "../src/bot.js";
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

function createService() {
  const api = createApi();
  const service = new TeleTopazService(api, "1", "1", 0);

  (service as any).loadAllowedDirectories = vi.fn().mockResolvedValue([]);
  (service as any).getModels = vi.fn().mockResolvedValue(["gpt-5-mini"]);
  (service as any).safeSend = vi.fn().mockResolvedValue(undefined);
  (service as any).sessionMemory = { buildContext: vi.fn().mockResolvedValue(undefined) };

  return { service, api };
}

describe("/newproject command", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "teletopaz-newproject-"));
    // Create a fake existing project inside the tmp workspace
    await fs.mkdir(path.join(tmpDir, "ExistingProject"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a new project directory successfully", async () => {
    const { service } = createService();
    const state = (service as any).getOrCreateState(1);
    state.workDir = path.join(tmpDir, "ExistingProject");

    await (service as any).handleNewProject(1, "NewApp");

    const safeSend = (service as any).safeSend;
    expect(safeSend).toHaveBeenCalledWith(
      1,
      expect.stringContaining("✅ 專案 NewApp 已建立"),
      undefined
    );

    const stat = await fs.stat(path.join(tmpDir, "NewApp"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("rejects names with illegal characters", async () => {
    const { service } = createService();
    const state = (service as any).getOrCreateState(1);
    state.workDir = path.join(tmpDir, "ExistingProject");

    await (service as any).handleNewProject(1, "bad name!");

    const safeSend = (service as any).safeSend;
    expect(safeSend).toHaveBeenCalledWith(
      1,
      expect.stringContaining("❌ 專案名稱僅允許英數字"),
      undefined
    );
  });

  it("rejects empty name", async () => {
    const { service } = createService();
    const state = (service as any).getOrCreateState(1);
    state.workDir = path.join(tmpDir, "ExistingProject");

    await (service as any).handleNewProject(1, "");

    const safeSend = (service as any).safeSend;
    expect(safeSend).toHaveBeenCalledWith(
      1,
      expect.stringContaining("請提供專案名稱"),
      undefined
    );
  });

  it("rejects when directory already exists", async () => {
    const { service } = createService();
    const state = (service as any).getOrCreateState(1);
    state.workDir = path.join(tmpDir, "ExistingProject");

    await (service as any).handleNewProject(1, "ExistingProject");

    const safeSend = (service as any).safeSend;
    expect(safeSend).toHaveBeenCalledWith(
      1,
      expect.stringContaining("❌ 專案 ExistingProject 已存在"),
      undefined
    );
  });

  it("prompts to select project when workDir is not set", async () => {
    const { service } = createService();
    const state = (service as any).getOrCreateState(1);
    state.workDir = undefined;

    await (service as any).handleNewProject(1, "NewApp");

    const safeSend = (service as any).safeSend;
    expect(safeSend).toHaveBeenCalledWith(
      1,
      expect.stringContaining("請先使用 /project 選擇專案"),
      undefined
    );
  });

  it("rejects names with path traversal characters", async () => {
    const { service } = createService();
    const state = (service as any).getOrCreateState(1);
    state.workDir = path.join(tmpDir, "ExistingProject");

    await (service as any).handleNewProject(1, "../escape");

    const safeSend = (service as any).safeSend;
    expect(safeSend).toHaveBeenCalledWith(
      1,
      expect.stringContaining("❌ 專案名稱僅允許英數字"),
      undefined
    );
  });
});
