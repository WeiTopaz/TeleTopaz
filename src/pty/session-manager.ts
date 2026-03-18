import { PtyRunner, type PtyRunnerOptions, type PtyRunnerResult } from "./runner.js";
import { SessionPacer } from "./session-pacer.js";
import { EventEmitter } from "node:events";
import { logger } from "../util/logger.js";

export type PtySessionState = "idle" | "running" | "crashed" | "restarting";

export type PtySessionEvents = {
  crash: { error: Error; crashCount: number };
  fatal: { error: Error };
  restarting: { backoff: number; attempt: number };
  recovered: void;
};

/**
 * 管理單個 CLI PTY 會話的生命週期
 * 負責崩潰偵測、自動重連、狀態恢復
 */
export class PtySessionManager extends EventEmitter {
  private runner: PtyRunner | null = null;
  private pacer: SessionPacer;
  private state: PtySessionState = "idle";
  private crashCount = 0;
  private maxCrashRetries = 3;
  private crashWindowMs = 60_000;
  private firstCrashTime = 0;

  constructor() {
    super();
    this.pacer = new SessionPacer();
  }

  getState(): PtySessionState {
    return this.state;
  }

  getRunner(): PtyRunner | null {
    return this.runner;
  }

  /**
   * 執行一次 CLI 指令
   * 自動處理操作節奏延遲與崩潰恢復
   */
  async execute(options: PtyRunnerOptions): Promise<PtyRunnerResult> {
    // 操作節奏延遲
    const delay = this.pacer.getDelay();
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    this.state = "running";
    this.runner = new PtyRunner();

    try {
      const result = await this.runner.execute(options);
      this.state = "idle";
      this.runner = null;
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      // aborted 不算崩潰
      if (error.message === "aborted") {
        this.state = "idle";
        this.runner = null;
        throw error;
      }

      await this.handleCrash(error, options);
      throw error;
    }
  }

  /**
   * 透過當前 runner 輸入文字
   */
  async typeInput(text: string): Promise<void> {
    if (!this.runner) throw new Error("No active PTY session");
    await this.runner.typeInput(text);
  }

  /**
   * 直接寫入（y/n 回應等）
   */
  writeImmediate(text: string): void {
    this.runner?.writeImmediate(text);
  }

  private async handleCrash(error: Error, lastOptions: PtyRunnerOptions): Promise<void> {
    this.state = "crashed";
    const now = Date.now();

    if (now - this.firstCrashTime > this.crashWindowMs) {
      this.crashCount = 0;
      this.firstCrashTime = now;
    }

    this.crashCount++;
    this.emit("crash", { error, crashCount: this.crashCount });
    logger.warn("PTY session crashed", { crashCount: this.crashCount, error: error.message });

    if (this.crashCount > this.maxCrashRetries) {
      const fatalError = new Error(
        `PTY crashed ${this.crashCount} times in ${this.crashWindowMs}ms: ${error.message}`
      );
      this.emit("fatal", { error: fatalError });
      this.state = "idle";
      this.runner = null;
      return;
    }

    // 指數退避
    const backoff = Math.min(1000 * Math.pow(2, this.crashCount - 1), 30_000);
    this.state = "restarting";
    this.emit("restarting", { backoff, attempt: this.crashCount });
  }

  async destroy(): Promise<void> {
    this.runner?.kill();
    this.runner = null;
    this.state = "idle";
  }
}
