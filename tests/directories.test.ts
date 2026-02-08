import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { expandDirectoryPatterns, isAllowedDirectory } from "../src/config/directories.js";

describe("directories", () => {
  it("expands glob patterns", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "teletopaz-"));
    const dirA = path.join(root, "a");
    await fs.mkdir(dirA);
    const result = await expandDirectoryPatterns([`${root}/*`]);
    expect(result).toContain(path.resolve(dirA));
  });

  it("validates allowed directory", () => {
    const dir = path.resolve("/tmp");
    expect(isAllowedDirectory([dir], dir)).toBe(true);
  });
});
