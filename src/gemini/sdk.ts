import { spawn } from "node:child_process";
import type { AiClient, AiSession, AiEvent, AiSessionOptions, AiProviderInfo } from "../provider/types.js";

const retryBackoffsMs = [1000, 2000, 5000];

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
    // Include the specific API error format seen in logs
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

export class GeminiSdkClient implements AiClient {
  async start(): Promise<void> {
    // No-op
  }

  async stop(): Promise<void> {
    // No-op
  }

  async createSession(options: AiSessionOptions): Promise<GeminiSdkSession> {
    return new GeminiSdkSession(options);
  }

  async queryProviderInfo(): Promise<AiProviderInfo> {
    // Return static list as querying CLI is complex without session
    return {
      models: [
        "gemini-3-pro-preview",
        "gemini-3-flash-preview",
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite"
      ],
      version: "CLI-Wrapper"
    };
  }
}

export class GeminiSdkSession implements AiSession {
  private options: AiSessionOptions;
  private history: Array<{ role: "user" | "model"; content: string }> = [];
  private eventHandler?: (event: AiEvent) => void;
  private abortController: AbortController | undefined;

  constructor(options: AiSessionOptions) {
    this.options = options;
  }

  onEvent(handler: (event: AiEvent) => void): void {
    this.eventHandler = handler;
  }

  async send(prompt: string): Promise<void> {
    this.history.push({ role: "user", content: prompt });
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    try {
      await this.sendPromptWithRetry(prompt, signal);
    } catch (err) {
      if (signal.aborted) return;
      
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("Gemini CLI Error:", errorMsg);
      
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
        const response = await this.spawnGeminiCli(prompt, signal);
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
        // If retryable, loop continues
        console.warn(`Gemini CLI retryable error (attempt ${attempt + 1}):`, error.message);
      }
    }

    if (lastErr) {
      throw new Error(`max retries exceeded: ${lastErr.message}`);
    }
  }

  async sendAndWait(prompt: string, timeoutMs?: number): Promise<unknown> {
    throw new Error("sendAndWait not implemented for Gemini CLI wrapper");
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
    let parts: string[] = [];
    if (this.options.systemPrompt) {
      parts.push(this.options.systemPrompt);
    }

    for (const item of this.history) {
      // Use simple separators. 
      // The CLI might get confused if we use "User:"/"Model:" prefixes if the model is chat-tuned 
      // but expecting raw prompt. However, Ralph uses `combinedPrompt` which is system + prompt.
      // Ralph doesn't seem to maintain history in the `CopilotClient` class itself! 
      // It sends the *whole* prompt each time? 
      // Looking at Ralph's `LoopEngine`: it likely builds the prompt.
      // Here in TeleTopaz, the session is responsible for history.
      // We will join them with newlines.
      parts.push(item.content);
    }
    return parts.join("\n\n");
  }

  private spawnGeminiCli(prompt: string, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      // Use full history for the prompt context since we are starting a fresh CLI process each time
      const fullPrompt = this.buildFullPrompt();
      
      const args = ["-m", this.options.model, "--output-format", "text", "--approval-mode", "yolo"];
      const cwd = this.options.workingDirectory || process.cwd();

      const child = spawn("gemini", args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: cwd
      });

      let responseText = "";
      let errorText = "";
      let resolved = false;

      const cleanup = () => {
        signal.removeEventListener("abort", abortHandler);
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

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      child.stdout.on("data", (chunk) => {
        responseText += chunk;
      });

      child.stderr.on("data", (chunk) => {
        errorText += chunk;
      });

      child.on("error", (err) => {
        finish(err);
      });

      child.on("close", (code) => {
        if (signal.aborted) return;
        if (code === 0) {
          finish(null, responseText);
        } else {
          // Check if errorText contains the known API error and treat it as such
          const errMsg = errorText || `Gemini CLI exited with code ${code}`;
          finish(new Error(errMsg));
        }
      });

      child.stdin.write(fullPrompt);
      child.stdin.end();
    });
  }
}
