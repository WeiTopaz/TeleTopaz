import { stripAnsi } from "./ansi-parser.js";

/**
 * 多策略指令完成偵測器
 *
 * 策略 1: Shell Prompt 偵測 — 當 CLI 回到等待輸入狀態
 * 策略 2: 靜默超時 — 連續 N 秒無新輸出
 * 策略 3: 特徵字串 — 偵測 CLI 的結束標記
 */
export class CompletionDetector {
  private timer: NodeJS.Timeout | null = null;
  private silentThresholdMs: number;
  private onComplete: () => void;

  // CLI 在互動模式下的 prompt 特徵
  private promptPatterns = [
    /^❯\s*$/m,
    /^>\s*$/m,
    /^gemini>\s*$/m,
    /\$ $/m,
  ];

  constructor(onComplete: () => void, silentThresholdMs = 3000) {
    this.onComplete = onComplete;
    this.silentThresholdMs = silentThresholdMs;
  }

  /** 每次收到 onData 時呼叫，回傳 true 表示偵測到 prompt */
  feed(data: string): boolean {
    this.resetTimer();

    const clean = stripAnsi(data);
    for (const pattern of this.promptPatterns) {
      if (pattern.test(clean)) {
        return true;
      }
    }
    return false;
  }

  private resetTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.onComplete();
    }, this.silentThresholdMs);
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
