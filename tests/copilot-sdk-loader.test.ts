import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureVscodeJsonrpcNodeShim } from "../src/copilot/sdk.js";

describe("ensureVscodeJsonrpcNodeShim", () => {
  it("creates an extensionless node shim when vscode-jsonrpc only provides node.js", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "teletopaz-sdk-loader-"));
    const nodeModulesRoot = path.join(root, "node_modules");
    const jsonrpcDir = path.join(nodeModulesRoot, "vscode-jsonrpc");
    const shimPath = path.join(jsonrpcDir, "node");
    const targetPath = path.join(jsonrpcDir, "node.js");

    try {
      await fs.mkdir(jsonrpcDir, { recursive: true });
      await fs.writeFile(targetPath, "module.exports = { ok: true };\n", "utf8");

      const created = await ensureVscodeJsonrpcNodeShim(nodeModulesRoot);

      expect(created).toBe(true);
      await expect(fs.readFile(shimPath, "utf8")).resolves.toContain("require('./node.js')");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an existing shim untouched", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "teletopaz-sdk-loader-"));
    const nodeModulesRoot = path.join(root, "node_modules");
    const jsonrpcDir = path.join(nodeModulesRoot, "vscode-jsonrpc");
    const shimPath = path.join(jsonrpcDir, "node");
    const targetPath = path.join(jsonrpcDir, "node.js");

    try {
      await fs.mkdir(jsonrpcDir, { recursive: true });
      await fs.writeFile(targetPath, "module.exports = { ok: true };\n", "utf8");
      await fs.writeFile(shimPath, "existing shim\n", "utf8");

      const created = await ensureVscodeJsonrpcNodeShim(nodeModulesRoot);

      expect(created).toBe(false);
      await expect(fs.readFile(shimPath, "utf8")).resolves.toBe("existing shim\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
