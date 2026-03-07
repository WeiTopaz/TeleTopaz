import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSandboxProfile, isSandboxActive, isSandboxEnabled } from "./sandbox-profile.js";
import { loadDirectoryPatterns } from "./config/directories.js";
import { loadSecrets } from "./config/secrets.js";
import { logger } from "./util/logger.js";

export function requireSandboxDirectoryPatterns(patterns: string[]): string[] {
  if (patterns.length === 0) {
    throw new Error("TELETOPAZ_DIRECTORY_PATTERNS 必須至少設定一個可用根目錄，沙盒才能安全啟動。");
  }

  return patterns;
}

export async function ensureSandbox(): Promise<void> {
  if (process.platform !== "darwin") return;
  if (isSandboxActive()) return;
  if (!isSandboxEnabled()) return;

  const secrets = await loadSecrets();
  const patterns = requireSandboxDirectoryPatterns(await loadDirectoryPatterns(secrets.directoryPatterns));
  const profile = buildSandboxProfile({ directoryPatterns: patterns });
  const profilePath = path.join(os.tmpdir(), `teletopaz-sandbox-${process.pid}.sb`);
  await fs.writeFile(profilePath, profile, "utf8");

  const args = ["-f", profilePath, "--", process.execPath, ...process.argv.slice(1)];
  const env = { ...process.env, TELETOPAZ_SANDBOX_ACTIVE: "1" };
  logger.info("Launching sandboxed process", { profilePath });

  const child = spawn("/usr/bin/sandbox-exec", args, { stdio: "inherit", env });
  child.on("error", (err) => {
    logger.error("Sandbox launch failed", err);
    process.exit(1);
  });
  await new Promise<void>((resolve) => {
    child.on("exit", async (code, signal) => {
      try {
        await fs.unlink(profilePath);
      } catch (err) {
        logger.warn("Sandbox profile cleanup failed", err);
      }
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 0);
      resolve();
    });
  });
}
