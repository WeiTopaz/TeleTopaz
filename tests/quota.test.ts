import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockReadFile, mockWriteFile, mockMkdir, mockReaddir } = vi.hoisted(() => {
  const mockReadFile = vi.fn();
  const mockWriteFile = vi.fn().mockResolvedValue(undefined);
  const mockMkdir = vi.fn().mockResolvedValue(undefined);
  const mockReaddir = vi.fn().mockResolvedValue([]);
  return { mockReadFile, mockWriteFile, mockMkdir, mockReaddir };
});

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    mkdir: mockMkdir,
    readdir: mockReaddir,
  },
}));

import { QuotaService } from "../src/services/quota.js";

describe("QuotaService", () => {
  let service: QuotaService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new QuotaService();
    mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    mockReaddir.mockResolvedValue([]);
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
  });

  it("checkQuota returns allowed: true with remaining 9999 when no data exists", async () => {
    const result = await service.checkQuota("chat_1");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9999);
    expect(result.stats.daily).toBe(0);
    expect(result.stats.monthly).toBe(0);
  });

  it("increment persists daily count for a chat", async () => {
    mockReadFile.mockRejectedValueOnce(new Error("ENOENT")); // first readDaily returns empty
    mockReaddir.mockResolvedValue([]); // no monthly files

    const stats = await service.increment("chat_1", "copilot", "gpt-4");

    expect(stats.daily).toBe(1);
    expect(mockWriteFile).toHaveBeenCalledOnce();

    const writtenData = JSON.parse(mockWriteFile.mock.calls[0]![1] as string) as Record<string, unknown>;
    const entry = (writtenData["chat_1"] as any);
    expect(entry.count).toBe(1);
    expect(entry.byProvider["copilot"]).toBe(1);
    expect(entry.byModel["gpt-4"]).toBe(1);
  });

  it("increment accumulates daily count across multiple calls", async () => {
    const existingRecord = {
      chat_1: { count: 3, byProvider: { copilot: 3 }, byModel: { "gpt-4": 3 } },
    };
    mockReadFile.mockResolvedValueOnce(JSON.stringify(existingRecord));
    mockReaddir.mockResolvedValue([]);

    const stats = await service.increment("chat_1", "copilot", "gpt-4");
    expect(stats.daily).toBe(4);
  });

  it("tracks per-model breakdown in monthly stats", async () => {
    const today = new Date().toLocaleDateString("en-CA");

    mockReaddir.mockResolvedValue([`${today}.json`]);
    const dailyRecord = {
      chat_1: {
        count: 2,
        byProvider: { gemini: 2 },
        byModel: { "gemini-pro": 1, "gemini-flash": 1 },
      },
    };
    mockReadFile.mockResolvedValue(JSON.stringify(dailyRecord));

    const result = await service.checkQuota("chat_1");
    expect(result.stats.monthly).toBe(2);
    expect(result.stats.byModel["gemini-pro"]).toBe(1);
    expect(result.stats.byModel["gemini-flash"]).toBe(1);
  });

  it("handles missing stats file gracefully in checkQuota", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockReaddir.mockRejectedValue(new Error("ENOENT")); // stats dir missing

    const result = await service.checkQuota("chat_new");
    expect(result.allowed).toBe(true);
    expect(result.stats.daily).toBe(0);
    expect(result.stats.monthly).toBe(0);
  });

  it("resets daily count on new day (reads fresh file with no entry)", async () => {
    // Simulate a fresh day — no record for today's chatId
    mockReadFile.mockResolvedValueOnce(JSON.stringify({ other_chat: { count: 5, byProvider: {}, byModel: {} } }));
    mockReaddir.mockResolvedValue([]);

    const result = await service.checkQuota("chat_1");
    expect(result.stats.daily).toBe(0);
  });
});
