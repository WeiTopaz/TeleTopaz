import { describe, it, expect } from "vitest";
import { parseIndex, formatJsonResult } from "../src/util/format.js";


describe("format", () => {
  it("parses 1-based index", () => {
    expect(parseIndex("1", 3)).toBe(0);
    expect(parseIndex("0", 3)).toBe(-1);
  });

  it("formats json", () => {
    expect(formatJsonResult("{\"a\":1}")?.includes("\n")).toBe(true);
  });
});
