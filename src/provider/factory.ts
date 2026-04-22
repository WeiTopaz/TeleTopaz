import { ClaudeCodeSdkClient } from "../claude/sdk.js";
import { CodexSdkClient } from "../codex/sdk.js";
import { CopilotSdkClient } from "../copilot/sdk.js";
import { GeminiSdkClient } from "../gemini/sdk.js";
import { GeminiPtyClient } from "../gemini/pty-session.js";
import type { AiClient, ProviderType } from "./types.js";

export function createProviderClient(provider: ProviderType): AiClient {
  if (provider === "gemini") {
    return process.env["TELETOPAZ_USE_PTY"] === "1" ? new GeminiPtyClient() : new GeminiSdkClient();
  }
  if (provider === "claude-code") return new ClaudeCodeSdkClient();
  if (provider === "codex") return new CodexSdkClient();
  return new CopilotSdkClient();
}
