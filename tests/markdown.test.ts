import { describe, it, expect } from "vitest";
import { markdownToTelegram, splitLongMessage } from "../src/util/markdown.js";

describe("markdownToTelegram", () => {
  it("escapes underscores in tool names (snake_case)", () => {
    const result = markdownToTelegram("report_intent");
    expect(result).toBe("report\\_intent");
  });

  it("escapes multiple underscores in identifiers", () => {
    const result = markdownToTelegram("snake_case_name");
    expect(result).toBe("snake\\_case\\_name");
  });

  it("converts **bold** to *bold*", () => {
    const result = markdownToTelegram("Hello **world**");
    expect(result).toBe("Hello *world*");
  });

  it("converts ~~strikethrough~~ to ~strikethrough~", () => {
    const result = markdownToTelegram("Hello ~~deleted~~ text");
    expect(result).toBe("Hello ~deleted~ text");
  });

  it("preserves _italic_ at word boundaries", () => {
    const result = markdownToTelegram("Hello _italic_ text");
    expect(result).toBe("Hello _italic_ text");
  });

  it("does not treat underscores inside words as italic", () => {
    const result = markdownToTelegram("tool_execution_start is running");
    expect(result).toBe("tool\\_execution\\_start is running");
  });

  it("escapes dots, parens, and other MarkdownV2 special chars", () => {
    const result = markdownToTelegram("Hello (world). Test!");
    expect(result).toBe("Hello \\(world\\)\\. Test\\!");
  });

  it("converts # heading to bold", () => {
    const result = markdownToTelegram("# Title");
    expect(result).toBe("*Title*");
  });

  it("handles mixed tool output with underscores and formatting", () => {
    const input = "工具完成：report_intent\n結果摘要：OK";
    const result = markdownToTelegram(input);
    expect(result).toContain("report\\_intent");
  });

  it("preserves code blocks without extra escaping", () => {
    const result = markdownToTelegram("text ```code_block``` more");
    // Inside code blocks, only \ and ` are escaped; _ is NOT escaped
    expect(result).toContain("```code_block```");
  });

  it("preserves inline code without extra escaping", () => {
    const result = markdownToTelegram("use `my_func` here");
    // Inside inline code, only \ and ` are escaped; _ is NOT escaped
    expect(result).toContain("`my_func`");
  });

  it("handles empty string", () => {
    expect(markdownToTelegram("")).toBe("");
  });

  it("handles plain text with no special characters", () => {
    expect(markdownToTelegram("hello world")).toBe("hello world");
  });

  it("handles __underline__ formatting", () => {
    const result = markdownToTelegram("Hello __underline__ text");
    expect(result).toBe("Hello __underline__ text");
  });

  it("produces valid MarkdownV2 for tool names in status messages", () => {
    const input = "工具執行中：web_fetch\n參數摘要：url=https://example.com";
    const result = markdownToTelegram(input);
    // All underscores in identifiers must be escaped
    expect(result).toContain("web\\_fetch");
    // Dots and colons/slashes must be escaped
    expect(result).toContain("example\\.com");
  });
});

describe("splitLongMessage", () => {
  it("returns single chunk for short messages", () => {
    expect(splitLongMessage("short")).toEqual(["short"]);
  });

  it("splits at newline within 80% boundary", () => {
    const line = "a".repeat(3200) + "\n" + "b".repeat(800);
    const chunks = splitLongMessage(line, 4096);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});
