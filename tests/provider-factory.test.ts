import { describe, it, expect, afterEach } from "vitest";
import { createProviderClient } from "../src/provider/factory.js";
import { ClaudeCodeSdkClient } from "../src/claude/sdk.js";
import { CodexSdkClient } from "../src/codex/sdk.js";
import { CopilotSdkClient } from "../src/copilot/sdk.js";
import { GeminiSdkClient } from "../src/gemini/sdk.js";
import { GeminiPtyClient } from "../src/gemini/pty-session.js";

afterEach(() => {
  delete process.env["TELETOPAZ_USE_PTY"];
});

describe("createProviderClient", () => {
  it("returns CopilotSdkClient for copilot", () => {
    const client = createProviderClient("copilot");
    expect(client).toBeInstanceOf(CopilotSdkClient);
  });

  it("returns ClaudeCodeSdkClient for claude-code", () => {
    const client = createProviderClient("claude-code");
    expect(client).toBeInstanceOf(ClaudeCodeSdkClient);
  });

  it("returns CodexSdkClient for codex", () => {
    const client = createProviderClient("codex");
    expect(client).toBeInstanceOf(CodexSdkClient);
  });

  it("returns GeminiSdkClient for gemini when TELETOPAZ_USE_PTY is not set", () => {
    const client = createProviderClient("gemini");
    expect(client).toBeInstanceOf(GeminiSdkClient);
  });

  it("returns GeminiPtyClient for gemini when TELETOPAZ_USE_PTY=1", () => {
    process.env["TELETOPAZ_USE_PTY"] = "1";
    const client = createProviderClient("gemini");
    expect(client).toBeInstanceOf(GeminiPtyClient);
  });

  it("returns GeminiSdkClient for gemini when TELETOPAZ_USE_PTY is other value", () => {
    process.env["TELETOPAZ_USE_PTY"] = "0";
    const client = createProviderClient("gemini");
    expect(client).toBeInstanceOf(GeminiSdkClient);
  });
});
