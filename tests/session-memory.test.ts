import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionMemoryStore } from "../src/session/memory-store.js";

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "teletopaz-memory-"));
}

describe("SessionMemoryStore", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("stores redacted entries per workspace and builds prompt context", async () => {
    tempDir = await createTempDir();
    const store = new SessionMemoryStore({ baseDir: tempDir, maxEntries: 5, maxChars: 200 });
    const scope = { chatId: 7, workDir: "/tmp/Alpha" };

    await store.append(scope, "user", "部署 token=sk-abcdef1234567890ABCDE 並通知 dev@example.com");
    await store.append(scope, "assistant", "我會先檢查 staging health check");

    const entries = await store.read(scope);
    expect(entries).toHaveLength(2);
    expect(JSON.stringify(entries)).not.toContain("sk-abcdef1234567890ABCDE");
    expect(JSON.stringify(entries)).not.toContain("dev@example.com");

    const context = await store.buildContext(scope, 4);
    expect(context).toContain("Alpha");
    expect(context).toContain("[user]");
    expect(context).toContain("[assistant]");
    expect(context).toContain("staging health check");
  });

  it("keeps only the most recent entries and isolates workspaces", async () => {
    tempDir = await createTempDir();
    const store = new SessionMemoryStore({ baseDir: tempDir, maxEntries: 2, maxChars: 120 });
    const alpha = { chatId: 7, workDir: "/tmp/Alpha" };
    const beta = { chatId: 7, workDir: "/tmp/Beta" };

    await store.append(alpha, "user", "first");
    await store.append(alpha, "assistant", "second");
    await store.append(alpha, "user", "third");
    await store.append(beta, "user", "beta-only");

    const alphaEntries = await store.read(alpha);
    const betaEntries = await store.read(beta);

    expect(alphaEntries.map((entry) => entry.text)).toEqual(["second", "third"]);
    expect(betaEntries.map((entry) => entry.text)).toEqual(["beta-only"]);
  });
});
