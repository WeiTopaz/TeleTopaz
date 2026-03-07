import { describe, expect, it } from "vitest";
import { normalizeCopilotStartError } from "../src/copilot/sdk.js";

describe("normalizeCopilotStartError", () => {
  it("rewrites protocol mismatches into an actionable upgrade message", () => {
    const error = normalizeCopilotStartError(
      new Error("SDK protocol version mismatch: SDK expects version 2, but server reports version 3. Please update your SDK or server to ensure compatibility.")
    );

    expect(error.message).toContain("Copilot SDK 與 CLI 協定版本不相容");
    expect(error.message).toContain("SDK=2");
    expect(error.message).toContain("server=3");
    expect(error.message).toContain("@github/copilot-sdk");
  });
});
