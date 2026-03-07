import { describe, expect, it } from "vitest";
import { requireSandboxDirectoryPatterns } from "../src/sandbox.js";

describe("sandbox startup", () => {
  it("rejects startup when TELETOPAZ_DIRECTORY_PATTERNS is empty", () => {
    expect(() => requireSandboxDirectoryPatterns([])).toThrow(/TELETOPAZ_DIRECTORY_PATTERNS/);
  });

  it("accepts configured TELETOPAZ_DIRECTORY_PATTERNS", () => {
    expect(requireSandboxDirectoryPatterns(["/Users/test/Project/*"])).toEqual(["/Users/test/Project/*"]);
  });
});
