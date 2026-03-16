import { logger } from "../util/logger.js";

type QueueItem = {
  id: string;
  chatId: number;
  prompt: string;
  resolve: (result: string) => void;
  reject: (error: Error) => void;
  timestamp: number;
  abortSignal: AbortSignal | undefined;
};

/**
 * CLI 請求佇列
 *
 * 設計考量：
 * 1. CLI 是單一互動式進程，不支援併發
 * 2. 多個 Telegram 使用者可能同時發送指令
 * 3. 需要公平排隊 + 超時保護 + 優雅取消
 */
export class RequestQueue {
  private queue: QueueItem[] = [];
  private processing = false;
  private maxQueueSize: number;
  private queueTimeoutMs: number;
  private executeCli: (item: QueueItem) => Promise<string>;

  constructor(options?: { maxQueueSize?: number; queueTimeoutMs?: number }) {
    this.maxQueueSize = options?.maxQueueSize ?? 15;
    this.queueTimeoutMs = options?.queueTimeoutMs ?? 300_000;
    this.executeCli = () => {
      throw new Error("executeCli not bound — call bindExecutor() first");
    };
  }

  async enqueue(
    chatId: number,
    prompt: string,
    signal?: AbortSignal
  ): Promise<string> {
    if (this.queue.length >= this.maxQueueSize) {
      throw new Error("佇列已滿，請稍後再試");
    }

    return new Promise<string>((resolve, reject) => {
      const item: QueueItem = {
        id: crypto.randomUUID(),
        chatId,
        prompt,
        resolve,
        reject,
        timestamp: Date.now(),
        abortSignal: signal,
      };

      // 超時自動移除
      const timer = setTimeout(() => {
        const idx = this.queue.indexOf(item);
        if (idx >= 0) {
          this.queue.splice(idx, 1);
          reject(new Error("請求在佇列中等待超時"));
        }
      }, this.queueTimeoutMs);

      // 取消信號處理
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        const idx = this.queue.indexOf(item);
        if (idx >= 0) {
          this.queue.splice(idx, 1);
          reject(new Error("請求已取消"));
        }
      });

      this.queue.push(item);
      this.processNext();
    });
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    const item = this.queue.shift()!;

    try {
      if (item.abortSignal?.aborted) {
        item.reject(new Error("請求已取消"));
        return;
      }

      logger.info("Processing queued PTY request", { chatId: item.chatId, id: item.id });
      const result = await this.executeCli(item);
      item.resolve(result);
    } catch (err) {
      item.reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.processing = false;
      if (this.queue.length > 0) {
        // 加入短暫延遲，模擬人類操作節奏
        setTimeout(() => this.processNext(), 500 + Math.random() * 1000);
      }
    }
  }

  bindExecutor(fn: (item: { chatId: number; prompt: string; abortSignal: AbortSignal | undefined }) => Promise<string>): void {
    this.executeCli = fn;
  }

  getStatus(): { queueLength: number; processing: boolean } {
    return {
      queueLength: this.queue.length,
      processing: this.processing,
    };
  }
}
