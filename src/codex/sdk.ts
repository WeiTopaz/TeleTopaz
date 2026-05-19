import { spawn } from "node:child_process";
import type { AiAttachment, AiClient, AiSession, AiEvent, AiSessionOptions, AiProviderInfo } from "../provider/types.js";
import { isSandboxActive } from "../sandbox-profile.js";

const retryBackoffsMs = [1000, 2000, 5000];
const DEFAULT_CLI_TIMEOUT_MS = 1_800_000; // Codex gpt-5.5 長任務可能需要 30 分鐘
const CLI_TIMEOUT_ENV = "TELETOPAZ_CODEX_CLI_TIMEOUT_MS";
const TURN_COMPLETED_GRACE_MS = 60_000;

// 本地 CLI 整體 timeout 訊息；屬於「agent 卡死」而非網路暫態，不重試。
const LOCAL_CLI_TIMEOUT_MARKER = "Codex CLI exceeded";

export function resolveCodexCliTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[CLI_TIMEOUT_ENV];
  if (!raw) return DEFAULT_CLI_TIMEOUT_MS;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CLI_TIMEOUT_MS;
}

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
        "gpt-5.5",
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
   * TeleTopaz 已由外層 macOS sandbox-exec 隔離時，改用 Codex 官方 bypass 旗標，
   * 避免 yolo 模式再觸發內層 workspace-write sandbox 的 sandbox_apply 失敗。
   * 非 yolo 模式不可 bypass，否則 /allowall 關閉後仍會自動放行工具操作。
   */
  private resolveApprovalArgs(): string[] {
    switch (this.options.approvalMode) {
      case "plan":
        return ["--sandbox", "read-only"];
      case "auto_edit":
        return ["--sandbox", "workspace-write"];
      case "yolo":
        if (isSandboxActive()) {
          return ["--dangerously-bypass-approvals-and-sandbox"];
        }
        return ["--sandbox", "danger-full-access"];
      default:
        return [];
    }
  }

  private spawnCodexCli(prompt: string, signal: AbortSignal): Promise<string> {
    this.responseText = "";
    this.lastCommentaryText = "";

    return new Promise((resolve, reject) => {
      const fullPrompt = this.buildFullPrompt();
      const cwd = this.options.workingDirectory || process.cwd();
      const approvalArgs = this.resolveApprovalArgs();

      const args = [
        "exec",                         // 非互動模式
        "--json",                       // JSONL 輸出
        "--ignore-user-config",         // 隔離 ~/.codex/config.toml，避免載入 computer-use 等全域插件
        "--ignore-rules",               // 避免額外全域/專案 rules 改寫 bot 專用工作流
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
      let closeReceived = false;
      let turnCompletedTimer: NodeJS.Timeout | undefined;

      const cleanup = () => {
        signal.removeEventListener("abort", abortHandler);
        clearTimeout(timeoutTimer);
        if (turnCompletedTimer) clearTimeout(turnCompletedTimer);
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

      const cliTimeoutMs = resolveCodexCliTimeoutMs();
      const timeoutTimer = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(new Error("timeout: " + LOCAL_CLI_TIMEOUT_MARKER + " " + cliTimeoutMs + "ms"));
      }, cliTimeoutMs);

      const scheduleTurnCompletedFinish = () => {
        if (resolved || closeReceived || turnCompletedTimer) return;

        turnCompletedTimer = setTimeout(() => {
          if (resolved || closeReceived) return;
          child.stdout?.destroy();
          child.stderr?.destroy();
          if (!child.killed) child.kill("SIGKILL");
          finish(null, this.responseText);
        }, TURN_COMPLETED_GRACE_MS);
      };

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      child.stdout.on("data", (chunk: string) => {
        if (resolved) return;
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
          if (event.type === "turn.completed") {
            scheduleTurnCompletedFinish();
          }
        }
      });

      child.stderr.on("data", (chunk: string) => {
        if (resolved) return;
        errorText += chunk;
      });

      child.on("error", (err) => {
        finish(err);
      });

      child.on("close", (code) => {
        closeReceived = true;
        if (signal.aborted) return;
        // 處理殘留的 buffer
        if (stdoutBuffer.trim()) {
          try {
            const event = JSON.parse(stdoutBuffer) as Record<string, unknown>;
            this.handleStreamEvent(event);
            if (event.type === "turn.completed") {
              scheduleTurnCompletedFinish();
            }
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

    if (item) {
      const itemType = item.type as string | undefined;

      // 工具呼叫開始
      if (eventType === "item.started" && itemType === "command_execution") {
        this.emit({
          type: "tool.execution_start",
          data: {
            toolName: "shell",
            toolCallId: item.id as string | undefined,
            args: { command: item.command }
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
            output: item.aggregated_output,
            ...(item.exit_code === 0 ? {} : { error: item.aggregated_output })
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

      return;
    }

    const payload = event.payload;
    if (!payload || typeof payload !== "object") return;
    const record = payload as Record<string, unknown>;

    if (eventType === "event_msg") {
      if ((record.type as string | undefined) !== "agent_message") return;
      this.handleAgentMessage(record.message ?? record, this.extractString(record, ["phase"]));
      return;
    }

    if (eventType !== "response_item") return;
    const payloadType = record.type as string | undefined;

    if (payloadType === "message" && record.role === "assistant") {
      this.handleAgentMessage(record, this.extractString(record, ["phase"]));
      return;
    }

    if (payloadType === "function_call" || payloadType === "custom_tool_call" || payloadType === "tool_search_call") {
      const toolArgs = this.parseJsonValue(record.arguments ?? record.input);
      this.emit({
        type: "tool.execution_start",
        data: {
          toolName: this.extractString(record, ["name"]),
          toolCallId: this.extractString(record, ["call_id", "id"]),
          args: toolArgs,
          toolArgs
        }
      });
      return;
    }

    if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output" || payloadType === "tool_search_output") {
      const toolCallId = this.extractString(record, ["call_id", "id"]);
      const normalized = this.normalizeToolOutput(record.output);
      const error = record.error ?? record.err ?? normalized.error;
      this.emit({
        type: "tool.execution_complete",
        data: {
          toolCallId,
          status: error ? "error" : "success",
          output: normalized.output,
          ...(error ? { error } : {})
        }
      });
    }
  }

  private handleAgentMessage(payload: unknown, phase?: string): void {
    const text = this.extractText(payload);
    if (!text) return;

    if (phase === "commentary") {
      if (text === this.lastCommentaryText) return;
      this.lastCommentaryText = text;
      this.emit({
        type: "assistant.message_delta",
        data: { content: text, phase: "commentary" }
      });
      return;
    }

    this.responseText = text;
  }

  private extractText(payload: unknown): string | undefined {
    if (!payload) return undefined;
    if (typeof payload === "string") return payload;
    if (typeof payload !== "object") return undefined;

    const record = payload as Record<string, unknown>;
    const content = record.content ?? record.message ?? record.text ?? record.delta;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const parts = content.flatMap((item) => {
        if (typeof item === "string") return [item];
        if (item && typeof item === "object") {
          const text = (item as Record<string, unknown>).text;
          if (typeof text === "string") return [text];
        }
        return [];
      });
      if (parts.length) return parts.join("");
    }
    return undefined;
  }

  private extractString(record: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value) return value;
    }
    return undefined;
  }

  private parseJsonValue(value: unknown): unknown {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }

  private normalizeToolOutput(value: unknown): { output: unknown; error?: unknown } {
    const parsed = this.parseJsonValue(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { output: parsed };
    }

    const record = parsed as Record<string, unknown>;
    const output = record.output ?? parsed;
    const metadata = record.metadata;
    if (metadata && typeof metadata === "object") {
      const exitCode = (metadata as Record<string, unknown>).exit_code;
      if (typeof exitCode === "number" && exitCode !== 0) {
        return { output, error: output };
      }
    }

    return { output };
  }

  /** 供 spawnCodexCli 閉包存取最終回應 */
  private responseText = "";
  private lastCommentaryText = "";
}
