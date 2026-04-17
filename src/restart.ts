import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "./util/logger.js";

const GIT_SHA_RE = /^[0-9a-f]{40}$/i;

const STATE_DIR = path.join(os.homedir(), ".teletopaz");
const STATE_FILE = path.join(STATE_DIR, "restart-state.json");

export const EXIT_CODE_RESTART = 75;

export type RestartState = {
  triggeredBy: "user" | "system";
  triggeredAt: number;
  previousGitSha: string;
  hadUncommittedChanges: boolean;
  rollbackCount: number;
};

export function loadRestartState(): RestartState | null {
  try {
    if (!existsSync(STATE_FILE)) return null;
    const raw = readFileSync(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      (parsed.triggeredBy !== "user" && parsed.triggeredBy !== "system") ||
      typeof parsed.triggeredAt !== "number" ||
      typeof parsed.previousGitSha !== "string" ||
      !GIT_SHA_RE.test(parsed.previousGitSha) ||
      typeof parsed.hadUncommittedChanges !== "boolean" ||
      typeof parsed.rollbackCount !== "number"
    ) {
      logger.warn("Restart state failed validation, ignoring");
      return null;
    }
    return parsed as unknown as RestartState;
  } catch (err) {
    logger.warn("Failed to load restart state", err);
    return null;
  }
}

export function saveRestartState(state: RestartState): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

export function clearRestartState(): void {
  try {
    if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
  } catch (err) {
    logger.warn("Failed to clear restart state", err);
  }
}

export function getGitInfo(projectDir: string): { sha: string; hasUncommittedChanges: boolean } {
  execSync("git rev-parse --is-inside-work-tree", { cwd: projectDir, stdio: "pipe" });

  const sha = execSync("git rev-parse HEAD", { cwd: projectDir, stdio: "pipe" })
    .toString()
    .trim();

  const statusOutput = execSync("git status --porcelain", { cwd: projectDir, stdio: "pipe" })
    .toString()
    .trim();

  return { sha, hasUncommittedChanges: statusOutput.length > 0 };
}

export function performGitRollback(projectDir: string, state: RestartState): void {
  execSync("git rev-parse --is-inside-work-tree", { cwd: projectDir, stdio: "pipe" });

  if (state.hadUncommittedChanges) {
    if (!GIT_SHA_RE.test(state.previousGitSha)) {
      throw new Error(`Invalid git SHA: ${state.previousGitSha}`);
    }
    logger.info(`Git rollback: reset --hard ${state.previousGitSha}`);
    execFileSync("git", ["reset", "--hard", state.previousGitSha], { cwd: projectDir, stdio: "pipe" });
  } else {
    logger.info("Git rollback: reset --hard HEAD~1");
    execFileSync("git", ["reset", "--hard", "HEAD~1"], { cwd: projectDir, stdio: "pipe" });
  }
}
