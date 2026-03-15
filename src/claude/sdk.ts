import { spawn } from "node:child_process";
import type { AiAttachment, AiClient, AiSession, AiEvent, AiSessionOptions, AiProviderInfo } from "../provider/types.js";

const retryBackoffsMs = [1000, 2000, 5000];
const CLI_TIMEOUT_MS = 300_000; // Claude Code 可能需要較長時間（多輪工具呼叫）

type PreToolUseInput = { toolName: string | undefined; toolArgs: Record<string, unknown> | undefined };
type PreToolUseResult = { permissionDecision: string; modifiedArgs?: unknown };
type PreToolUseHook = (input: PreToolUseInput) => Promise<PreToolUseResult>;

/** 將 Claude CLI 的模型別名對應到完整模型 ID */
function resolveModelFlag(model: string): string {
  // Claude CLI 接受別名 (opus, sonnet) 或完整名稱 (claude-opus-4-6)
  // 這裡的 model 來自 SUPPORTED_MODELS，格式為 "claude-opus-4.6"
  // 需要轉換為 CLI 可用的格式 "claude-opus-4-6"
  return model.replace(/\./g, "-");
}

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
    message.includes("overloaded")
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

export class ClaudeCodeSdkClient implements AiClient {
  async start(): Promise<void> {
    // No-op — Claude Code CLI 不需要預先初始化
  }

  async stop(): Promise<void> {
    // No-op
  }

  async createSession(options: AiSessionOptions): Promise<ClaudeCodeSdkSession> {
    return new ClaudeCodeSdkSession(options);
  }

  async queryProviderInfo(): Promise<AiProviderInfo> {
    return {
      models: [
        "claude-opus-4.6",
        "claude-sonnet-4.6"
      ],
      version: "Claude-Code-CLI"
    };
  }
}

export class ClaudeCodeSdkSession implements AiSession {
  private options: AiSessionOptions;
  private history: Array<{ role: "user" | "assistant"; content: string }> = [];
  private eventHandler?: (event: AiEvent) => void;
  private abortController: AbortController | undefined;
  private onPreToolUse?: PreToolUseHook;

  constructor(options: AiSessionOptions) {
    this.options = options;
    const hooks = options.hooks as Record<string, unknown> | undefined;
    if (hooks?.onPreToolUse && typeof hooks.onPreToolUse === "function") {
      this.onPreToolUse = hooks.onPreToolUse as PreToolUseHook;
    }
  }

  onEvent(handler: (event: AiEvent) => void): void {
    this.eventHandler = handler;
  }

  async send(prompt: string, attachments?: AiAttachment[]): Promise<void> {
    let fullPrompt = prompt;
    if (attachments?.length) {
      const paths = attachments.map((a, i) => `${i + 1}. ${a.path}${a.displayName ? ` (${a.displayName})` : ""}`).join("\n");
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
      console.error("Claude Code CLI Error:", errorMsg);

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
        const response = await this.spawnClaudeCodeCli(prompt, signal);
        this.history.push({ role: "assistant", content: response });
        this.emit({ type: "assistant.message", data: { content: response } });
        this.emit({ type: "session.idle" });
        return;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastErr = error;

        if (!isRetryableError(error)) {
          throw error;
        }
        console.warn(`Claude Code CLI retryable error (attempt ${attempt + 1}):`, error.message);
      }
    }

    if (lastErr) {
      throw new Error(`max retries exceeded: ${lastErr.message}`);
    }
  }

  async sendAndWait(prompt: string, _timeoutMs?: number): Promise<unknown> {
    throw new Error("sendAndWait not implemented for Claude Code CLI wrapper");
  }

  async destroy(): Promise<void> {
    this.abortController?.abort();
  }

  async abort(): Promise<void> {
    this.abortController?.abort();
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
   * 將 AiSessionOptions.approvalMode 對應到 Claude CLI 的 --permission-mode
   */
  private resolvePermissionMode(): string {
    switch (this.options.approvalMode) {
      case "yolo":
        return "bypassPermissions";
      case "auto_edit":
        return "acceptEdits";
      case "plan":
        return "plan";
      default:
        return "default";
    }
  }

  private spawnClaudeCodeCli(prompt: string, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const fullPrompt = this.buildFullPrompt();
      const modelFlag = resolveModelFlag(this.options.model);
      const permissionMode = this.resolvePermissionMode();
      const cwd = this.options.workingDirectory || process.cwd();

      const args = [
        "-p",                               // print mode（非互動）
        "--output-format", "stream-json",   // 串流 JSON 輸出
        "--verbose",                        // stream-json 需要 --verbose
        "--model", modelFlag,
        "--permission-mode", permissionMode
      ];

      // 追加系統提示詞（如果有且非空）
      if (this.options.systemPrompt) {
        args.push("--system-prompt", this.options.systemPrompt);
      }

      // prompt 作為最後的位置參數
      args.push(fullPrompt);

      const child = spawn("claude", args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd
      });

      let responseText = "";
      let errorText = "";
      let stdoutBuffer = "";
      let resolved = false;

      const cleanup = () => {
        signal.removeEventListener("abort", abortHandler);
        clearTimeout(timeoutTimer);
      };

      const finish = (err: Error | null, result?: string) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        if (err) reject(err);
        else resolve(result || "");
      };

      const abortHandler = () => {
        if (!child.killed) child.kill("SIGTERM");
        finish(new Error("aborted"));
      };

      signal.addEventListener("abort", abortHandler);

      const timeoutTimer = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
        finish(new Error("timeout: Claude Code CLI exceeded " + CLI_TIMEOUT_MS + "ms"));
      }, CLI_TIMEOUT_MS);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      child.stdout.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }

          this.handleStreamEvent(event);

          // 從 result 事件提取最終回應
          if (event.type === "result" && typeof event.result === "string") {
            responseText = event.result;
          }

          // 從 assistant message 累積文字回應（備用）
          if (event.type === "assistant") {
            const msg = event.message as Record<string, unknown> | undefined;
            if (msg?.content && Array.isArray(msg.content)) {
              for (const block of msg.content as Array<Record<string, unknown>>) {
                if (block.type === "text" && typeof block.text === "string") {
                  // 不累積，因為 result 事件會有完整結果
                  // 但如果沒有 result 事件，這裡作為 fallback
                  if (!responseText) {
                    responseText += block.text as string;
                  }
                }
              }
            }
          }
        }
      });

      child.stderr.on("data", (chunk: string) => {
        errorText += chunk;
      });

      child.on("error", (err) => {
        finish(err);
      });

      child.on("close", (code) => {
        if (signal.aborted) return;
        // 處理殘留的 buffer
        if (stdoutBuffer.trim()) {
          try {
            const event = JSON.parse(stdoutBuffer) as Record<string, unknown>;
            if (event.type === "result" && typeof event.result === "string") {
              responseText = event.result;
            }
          } catch { /* ignore */ }
        }
        if (code === 0 || responseText) {
          finish(null, responseText);
        } else {
          const errMsg = errorText || `Claude Code CLI exited with code ${code}`;
          finish(new Error(errMsg));
        }
      });

      // Claude CLI -p 模式從位置參數取得 prompt，stdin 可直接關閉
      child.stdin.end();
    });
  }

  /**
   * 處理 Claude CLI stream-json 事件
   */
  private handleStreamEvent(event: Record<string, unknown>): void {
    // 工具呼叫事件
    if (event.type === "assistant") {
      const msg = event.message as Record<string, unknown> | undefined;
      if (msg?.content && Array.isArray(msg.content)) {
        for (const block of msg.content as Array<Record<string, unknown>>) {
          if (block.type === "tool_use") {
            const toolName = block.name as string | undefined;
            const toolArgs = block.input as Record<string, unknown> | undefined;
            this.emit({
              type: "tool.execution_start",
              data: { toolName, toolArgs }
            });
          }
        }
      }
    }

    // 工具結果事件
    if (event.type === "user") {
      const toolResult = event.tool_use_result as Record<string, unknown> | undefined;
      if (toolResult) {
        this.emit({
          type: "tool.execution_complete",
          data: {
            toolName: undefined,
            status: "success",
            output: toolResult
          }
        });
      }
    }
  }
}
