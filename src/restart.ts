import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "./util/logger.js";

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
    return JSON.parse(raw) as RestartState;
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
    logger.info(`Git rollback: reset --hard ${state.previousGitSha}`);
    execSync(`git reset --hard ${state.previousGitSha}`, { cwd: projectDir, stdio: "pipe" });
  } else {
    logger.info("Git rollback: reset --hard HEAD~1");
    execSync("git reset --hard HEAD~1", { cwd: projectDir, stdio: "pipe" });
  }
}
