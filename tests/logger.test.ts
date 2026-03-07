import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Logger } from "../src/util/logger.js";

describe("Logger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefixes console output with timestamp and level", () => {
    const logger = new Logger("info");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    logger.info("hello");

    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy.mock.calls[0]?.[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}\] \[INFO\]$/);
    expect(consoleSpy.mock.calls[0]?.slice(1)).toEqual(["hello"]);
  });

  it("writes to a configured log directory and flushes queued writes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "teletopaz-logger-"));
    const logger = new Logger("info");
    vi.spyOn(console, "log").mockImplementation(() => {});

    logger.setLogDir(tempDir);
    logger.info("persist me");
    await logger.flush();

    const files = await fs.readdir(tempDir);
    expect(files.length).toBe(1);

    const content = await fs.readFile(path.join(tempDir, files[0] ?? ""), "utf8");
    expect(content).toContain("persist me");

    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
