import { describe, it, expect } from "vitest";
import { buildPromptChunks, evaluateComposedPrompt } from "../src/session/prompt.js";

const policy = {
  version: 1,
  maxPromptLength: 10,
  denyRules: [],
  allowRules: []
};

describe("compose prompt", () => {
  it("allows short prompt without attachments", () => {
    const decision = evaluateComposedPrompt(policy, "short", []);
    expect(decision.allowed).toBe(true);
  });

  it("splits long prompt into chunks without losing content", () => {
    const input = "0123456789".repeat(8);
    const result = buildPromptChunks(input, 30);
    expect(result.total).toBeGreaterThan(1);
    for (const chunk of result.chunks) {
      expect(chunk.length).toBeLessThanOrEqual(30);
    }
    const reconstructed = result.chunks
      .map((chunk) => chunk.replace(/^\[PROMPT PART \d+\/\d+\]\n/, ""))
      .join("");
    expect(reconstructed).toBe(input);
  });
});
