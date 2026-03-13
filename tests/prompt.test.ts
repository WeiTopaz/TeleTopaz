import { describe, it, expect } from "vitest";
import { buildPromptChunks, composePrompt, evaluateComposedPrompt } from "../src/session/prompt.js";

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

  it("composePrompt includes file path when available", () => {
    const attachment = {
      dataUrl: "data:image/jpeg;base64,AAAA",
      mime: "image/jpeg",
      filePath: "/workspace/attachments/photo_1.jpg",
      addedAt: Date.now()
    };
    const composed = composePrompt("分析圖片", [attachment]);
    expect(composed).toContain("/workspace/attachments/photo_1.jpg");
    expect(composed).toContain("分析圖片");
    expect(composed).not.toContain("base64");
  });

  it("composePrompt falls back to inline label without filePath", () => {
    const attachment = {
      dataUrl: "data:image/jpeg;base64,AAAA",
      mime: "image/jpeg",
      addedAt: Date.now()
    };
    const composed = composePrompt("分析圖片", [attachment]);
    expect(composed).toContain("[inline image/jpeg]");
    expect(composed).toContain("分析圖片");
    expect(composed).not.toContain("base64");
  });

  it("allows composed prompt with attachments containing base64 data", () => {
    // Simulate a large image attachment whose base64 accidentally contains
    // semantic keywords like "cat", "env", "session", "token" etc.
    const fakeBase64 = "catenvtokensessionpasswordreadshowdisplay".repeat(100);
    const attachment = {
      dataUrl: `data:image/jpeg;base64,${fakeBase64}`,
      mime: "image/jpeg",
      addedAt: Date.now()
    };
    const widePolicy = { version: 1, maxPromptLength: 999999, denyRules: [], allowRules: [] };
    const decision = evaluateComposedPrompt(widePolicy, "分析這張圖片", [attachment]);
    expect(decision.allowed).toBe(true);
  });

  it("allows legitimate image analysis prompts with action+target words", () => {
    const attachment = {
      dataUrl: "data:image/jpeg;base64,AAAA",
      mime: "image/jpeg",
      addedAt: Date.now()
    };
    const widePolicy = { version: 1, maxPromptLength: 999999, denyRules: [], allowRules: [] };

    // These prompts contain action words like "顯示" and target words like "API"
    // but should NOT be blocked when they're about image analysis
    const decision = evaluateComposedPrompt(widePolicy, "請顯示圖片中的 API 端點", [attachment]);
    expect(decision.allowed).toBe(true);
  });
});
