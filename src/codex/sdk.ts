import { spawn } from "node:child_process";
import type { AiAttachment, AiClient, AiSession, AiEvent, AiSessionOptions, AiProviderInfo } from "../provider/types.js";

const retryBackoffsMs = [1000, 2000, 5000];
const CLI_TIMEOUT_MS = 300_000; // Codex 可能需要較長時間（多輪工具呼叫）

// 本地 CLI 整體 timeout 訊息；屬於「agent 卡死」而非網路暫態，不重試。
const LOCAL_CLI_TIMEOUT_MARKER = "Codex CLI exceeded";

export function isRetryableError(err: Error | null): boolean {
  if (!err) return false;
  const message = err.message;

  // 本地 CLI timeout 代表 agent 陷入工具循環或真的需要更久；重試只會讓人再等 5 分鐘。
  if (message.includes(LOCAL_CLI_TIMEOUT_MARKER)) return false;

  return (
    message.includes("GOAWAY") ||
    message.includes("connection reset") ||
    message.includes("connection refused") ||
    message.includes("connection terminated") ||
    message.includes("EOF") ||
    message.includes("ETIMEDOUT") ||
    message.includes("socket timeout") ||
    message.includes("connection timeout") ||
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

export class CodexSdkClient implements AiClient {
  async start(): Promise<void> {
    // No-op — Codex CLI 不需要預先初始化
  }

  async stop(): Promise<void> {
    // No-op
  }

  async createSession(options: AiSessionOptions): Promise<CodexSdkSession> {
    return new CodexSdkSession(options);
  }

  async queryProviderInfo(): Promise<AiProviderInfo> {
    return {
      models: [
        "gpt-5.4",
        "gpt-5.4-mini"
      ],
      version: "Codex-CLI"
    };
  }
}

export class CodexSdkSession implements AiSession {
  private options: AiSessionOptions;
  private history: Array<{ role: "user" | "assistant"; content: string }> = [];
  private eventHandler?: (event: AiEvent) => void;
  private abortController: AbortController | undefined;

  constructor(options: AiSessionOptions) {
    this.options = options;
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
      console.error("Codex CLI Error:", errorMsg);

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
        const response = await this.spawnCodexCli(prompt, signal);
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
        console.warn(`Codex CLI retryable error (attempt ${attempt + 1}):`, error.message);
      }
    }

    if (lastErr) {
      throw new Error(`max retries exceeded: ${lastErr.message}`);
    }
  }

  async sendAndWait(prompt: string, _timeoutMs?: number): Promise<unknown> {
    throw new Error("sendAndWait not implemented for Codex CLI wrapper");
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
   * 將 AiSessionOptions.approvalMode 對應到 Codex CLI 的旗標。
   * default/auto_edit 均映射到 --full-auto（workspace-write sandbox + 自動核准）；
   * spawn 無 TTY，未指定自動核准旗標時工具呼叫會卡住 approval prompt。
   */
  private resolveApprovalArgs(): string[] {
    switch (this.options.approvalMode) {
      case "yolo":
        return ["--yolo"];
      case "plan":
        return ["--sandbox", "read-only", "--full-auto"];
      case "auto_edit":
      default:
        return ["--full-auto"];
    }
  }

  private spawnCodexCli(prompt: string, signal: AbortSignal): Promise<string> {
    this.responseText = "";

    return new Promise((resolve, reject) => {
      const fullPrompt = this.buildFullPrompt();
      const cwd = this.options.workingDirectory || process.cwd();
      const approvalArgs = this.resolveApprovalArgs();

      const args = [
        "exec",                         // 非互動模式
        "--json",                       // JSONL 輸出
        "--skip-git-repo-check",        // 允許非 git repo 工作目錄（日記、筆記等）
        "-m", this.options.model,       // 模型
        "-C", cwd,                      // agent 工作根目錄
        ...approvalArgs,
        fullPrompt                      // prompt 作為最後的位置參數
      ];

      const child = spawn("codex", args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd
      });

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
        // 斷開 stdio pipe，避免 kill 到真正退出之間仍把殘留 JSONL flush 成 event
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(new Error("aborted"));
      };

      signal.addEventListener("abort", abortHandler);

      const timeoutTimer = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(new Error("timeout: " + LOCAL_CLI_TIMEOUT_MARKER + " " + CLI_TIMEOUT_MS + "ms"));
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
            this.handleStreamEvent(event);
          } catch { /* ignore */ }
        }
        if (code === 0 || this.responseText) {
          finish(null, this.responseText);
        } else {
          const errMsg = errorText || `Codex CLI exited with code ${code}`;
          finish(new Error(errMsg));
        }
      });

      // Codex exec 從位置參數取得 prompt，stdin 直接關閉
      child.stdin.end();
    });
  }

  private handleStreamEvent(event: Record<string, unknown>): void {
    const eventType = event.type as string | undefined;
    const item = event.item as Record<string, unknown> | undefined;

    if (!item) return;

    const itemType = item.type as string | undefined;

    // 工具呼叫開始
    if (eventType === "item.started" && itemType === "command_execution") {
      this.emit({
        type: "tool.execution_start",
        data: {
          toolName: "shell",
          toolCallId: item.id as string | undefined,
          toolArgs: { command: item.command }
        }
      });
    }

    // 工具呼叫完成
    if (eventType === "item.completed" && itemType === "command_execution") {
      this.emit({
        type: "tool.execution_complete",
        data: {
          toolCallId: item.id as string | undefined,
          status: item.exit_code === 0 ? "success" : "error",
          output: item.aggregated_output
        }
      });
    }

    // agent_message 完成 — 累積最終回應文字
    if (eventType === "item.completed" && itemType === "agent_message") {
      const text = item.text as string | undefined;
      if (text) {
        // 用最後一則 agent_message 作為最終回應
        // （Codex 可能在工具呼叫前後各產一段訊息，取最後一段作為 final）
        this.responseText = text;
      }
    }
  }

  /** 供 spawnCodexCli 閉包存取最終回應 */
  private responseText = "";
}
