import type { AiAttachment, AiClient, AiSession, AiEvent, AiSessionOptions, AiProviderInfo } from "../provider/types.js";
import { PtyRunner, type PtyRunnerResult } from "../pty/runner.js";
import { PtySessionManager } from "../pty/session-manager.js";
import { extractResponse, stripAnsi } from "../pty/ansi-parser.js";
import { sanitizePtyInput } from "../pty/sanitizer.js";
import { logger } from "../util/logger.js";

const retryBackoffsMs = [1000, 2000, 5000];
const CLI_TIMEOUT_MS = 120_000;

type PreToolUseInput = { toolName: string | undefined; toolArgs: Record<string, unknown> | undefined };
type PreToolUseResult = { permissionDecision: string; modifiedArgs?: unknown };
type PreToolUseHook = (input: PreToolUseInput) => Promise<PreToolUseResult>;

function isRetryableError(err: Error | null): boolean {
  if (!err) return false;
  const message = err.message;
  return (
    message.includes("GOAWAY") ||
    message.includes("connection reset") ||
    message.includes("connection refused") ||
    message.includes("connection terminated") ||
    message.includes("EOF") ||
    message.includes("timeout") ||
    message.includes("API Error")
  );
}

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve(true);
    }, { once: true });
  });
}

function toAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

export class GeminiPtyClient implements AiClient {
  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async createSession(options: AiSessionOptions): Promise<GeminiPtySession> {
    return new GeminiPtySession(options);
  }

  async queryProviderInfo(): Promise<AiProviderInfo> {
    return {
      models: ["gemini-3.1-pro-preview"],
      version: "CLI-PTY-Wrapper"
    };
  }
}

export class GeminiPtySession implements AiSession {
  private options: AiSessionOptions;
  private history: Array<{ role: "user" | "model"; content: string }> = [];
  private eventHandler?: (event: AiEvent) => void;
  private abortController: AbortController | undefined;
  private onPreToolUse?: PreToolUseHook;
  private sessionManager: PtySessionManager;

  constructor(options: AiSessionOptions) {
    this.options = options;
    this.sessionManager = new PtySessionManager();

    const hooks = options.hooks as Record<string, unknown> | undefined;
    if (hooks?.onPreToolUse && typeof hooks.onPreToolUse === "function") {
      this.onPreToolUse = hooks.onPreToolUse as PreToolUseHook;
    }

    // 監聽崩潰事件
    this.sessionManager.on("crash", ({ error, crashCount }) => {
      logger.warn("Gemini PTY crash", { crashCount, error: error.message });
    });
    this.sessionManager.on("fatal", ({ error }) => {
      logger.error("Gemini PTY fatal", { error: error.message });
    });
  }

  onEvent(handler: (event: AiEvent) => void): void {
    this.eventHandler = handler;
  }

  async send(prompt: string, attachments?: AiAttachment[]): Promise<void> {
    let fullPrompt = prompt;
    if (attachments?.length) {
      const paths = attachments.map((a, i) =>
        `${i + 1}. ${a.path}${a.displayName ? ` (${a.displayName})` : ""}`
      ).join("\n");
      fullPrompt = `${prompt}\n\n附件檔案（可用工具讀取）：\n${paths}`;
    }
    this.history.push({ role: "user", content: fullPrompt });
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    try {
      await this.sendPromptWithRetry(fullPrompt, signal);
    } catch (err) {
      if (signal.aborted) return;

      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error("Gemini PTY Error:", errorMsg);

      this.emit({
        type: "assistant.message",
        data: { content: `Error: ${errorMsg}` }
      });
      this.emit({ type: "session.idle" });
    } finally {
      this.abortController = undefined;
    }
  }

  private async sendPromptWithRetry(prompt: string, signal: AbortSignal): Promise<void> {
    let lastErr: Error | null = null;

    for (let attempt = 0; attempt <= retryBackoffsMs.length; attempt++) {
      if (signal.aborted) return;

      if (attempt > 0) {
        const backoff = retryBackoffsMs[attempt - 1] ?? 1000;
        const aborted = await sleep(backoff, signal);
        if (aborted) throw toAbortError(signal);
      }

      try {
        const response = await this.spawnGeminiPty(prompt, signal);
        this.history.push({ role: "model", content: response });
        this.emit({ type: "assistant.message", data: { content: response } });
        this.emit({ type: "session.idle" });
        return;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastErr = error;

        if (!isRetryableError(error)) {
          throw error;
        }
        logger.warn(`Gemini PTY retryable error (attempt ${attempt + 1}):`, error.message);
      }
    }

    if (lastErr) {
      throw new Error(`max retries exceeded: ${lastErr.message}`);
    }
  }

  async sendAndWait(_prompt: string, _timeoutMs?: number): Promise<unknown> {
    throw new Error("sendAndWait not implemented for Gemini PTY wrapper");
  }

  async destroy(): Promise<void> {
    this.abortController?.abort();
    await this.sessionManager.destroy();
  }

  async abort(): Promise<void> {
    this.abortController?.abort();
    await this.sessionManager.destroy();
  }

  private emit(event: AiEvent): void {
    this.eventHandler?.(event);
  }

  private buildFullPrompt(): string {
    const parts: string[] = [];
    if (this.options.systemPrompt) {
      parts.push(this.options.systemPrompt);
    }
    for (const item of this.history) {
      parts.push(item.content);
    }
    return parts.join("\n\n");
  }

  /**
   * 從互動模式的文字輸出中解析工具使用資訊
   */
  private parseToolEvents(text: string): void {
    // 偵測常見的工具使用模式
    // Gemini CLI 互動模式可能顯示如：
    //   「正在執行 read_file(path="/src/...")」
    //   「Tool: shell_command(command="...")」
    const toolPatterns = [
      /(?:Tool|工具|Executing|執行)[:\s]+(\w+)\s*\(/i,
      /(?:Running|呼叫)\s+(\w+)/i,
    ];

    for (const pattern of toolPatterns) {
      const match = pattern.exec(text);
      if (match) {
        this.emit({
          type: "tool.execution_start",
          data: { toolName: match[1], toolArgs: undefined }
        });
        break;
      }
    }
  }

  /**
   * 從提示文字中提取工具資訊
   */
  private extractToolInfo(promptText: string): PreToolUseInput {
    // 嘗試從互動提示中提取工具名稱
    const match = /(?:tool|工具|function|函數)[:\s]*["`']?(\w+)["`']?/i.exec(promptText);
    return {
      toolName: match?.[1],
      toolArgs: undefined,
    };
  }

  private async spawnGeminiPty(prompt: string, signal: AbortSignal): Promise<string> {
    const fullPrompt = this.buildFullPrompt();
    const approvalMode = this.options.approvalMode ?? "yolo";
    const cwd = this.options.workingDirectory || process.cwd();

    // PTY 模式下不使用 --output-format stream-json
    // Gemini CLI 在 TTY 環境下會自動使用互動模式
    const args = ["-m", this.options.model, "--approval-mode", approvalMode];

    const runner = new PtyRunner();

    // 設定互動提示處理
    const executePromise = runner.execute({
      command: "gemini",
      args,
      cwd,
      signal,
      timeoutMs: CLI_TIMEOUT_MS,

      onCleanOutput: (text) => {
        this.parseToolEvents(text);
      },

      onPromptDetected: async (promptText) => {
        // 瀏覽器開啟提示 — 自動跳過
        if (/Press Enter to open browser/i.test(promptText)) {
          runner.writeImmediate("\n");
          return;
        }

        if (this.onPreToolUse) {
          const toolInfo = this.extractToolInfo(promptText);
          try {
            const result = await this.onPreToolUse(toolInfo);
            if (result.permissionDecision === "deny") {
              runner.writeImmediate("n\n");
            } else {
              runner.writeImmediate("y\n");
            }
          } catch {
            runner.writeImmediate("n\n");
          }
        } else {
          // 預設自動同意
          runner.writeImmediate("y\n");
        }
      },
    });

    // 等待 CLI 啟動後再輸入 prompt
    // 給 CLI 一點時間初始化
    await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));

    // 擬人化輸入 prompt
    await runner.typeInput(fullPrompt);
    await runner.typeInput("\n");

    const result = await executePromise;
    return result.cleanOutput;
  }
}
