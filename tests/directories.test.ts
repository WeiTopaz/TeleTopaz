import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { expandDirectoryPatterns, isAllowedDirectory } from "../src/config/directories.js";

describe("directories", () => {
  it("expands glob patterns", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "teletopaz-"));
    const dirA = path.join(root, "a");
    try {
      await fs.mkdir(dirA);
      const result = await expandDirectoryPatterns([`${root}/*`]);
      expect(result).toContain(await fs.realpath(dirA));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("validates allowed directory", () => {
    const dir = path.resolve("/tmp");
    expect(isAllowedDirectory([dir], dir)).toBe(true);
  });

  it("rejects matched symlinks that resolve outside the allowed root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "teletopaz-"));
    const allowedRoot = path.join(root, "allowed");
    const externalDir = path.join(root, "external");
    const linkDir = path.join(allowedRoot, "link");

    try {
      await fs.mkdir(allowedRoot);
      await fs.mkdir(externalDir);
      await fs.symlink(externalDir, linkDir, "dir");

      const result = await expandDirectoryPatterns([`${allowedRoot}/*`]);
      expect(result).not.toContain(path.resolve(linkDir));
      expect(result).not.toContain(path.resolve(externalDir));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("matches allowed directories by canonical real path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "teletopaz-"));
    const realDir = path.join(root, "real");
    const linkDir = path.join(root, "alias");

    try {
      await fs.mkdir(realDir);
      await fs.symlink(realDir, linkDir, "dir");

      expect(isAllowedDirectory([realDir], linkDir)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
