import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { resolveAppDataDir } from "../src/util/app-data.js";

describe("resolveAppDataDir", () => {
  it("returns default ~/.teletopaz when env var is not set", () => {
    const result = resolveAppDataDir({});
    expect(result).toBe(path.join(os.homedir(), ".teletopaz"));
  });

  it("uses TELETOPAZ_DATA_DIR when set to absolute path", () => {
    const result = resolveAppDataDir({ TELETOPAZ_DATA_DIR: "/custom/data/path" });
    expect(result).toBe(path.resolve("/custom/data/path"));
  });

  it("trims whitespace from TELETOPAZ_DATA_DIR", () => {
    const result = resolveAppDataDir({ TELETOPAZ_DATA_DIR: "  /custom/path  " });
    expect(result).toBe(path.resolve("/custom/path"));
  });

  it("returns default when TELETOPAZ_DATA_DIR is empty string", () => {
    const result = resolveAppDataDir({ TELETOPAZ_DATA_DIR: "" });
    expect(result).toBe(path.join(os.homedir(), ".teletopaz"));
  });

  it("returns default when TELETOPAZ_DATA_DIR is whitespace only", () => {
    const result = resolveAppDataDir({ TELETOPAZ_DATA_DIR: "   " });
    expect(result).toBe(path.join(os.homedir(), ".teletopaz"));
  });

  it("resolves relative path in TELETOPAZ_DATA_DIR to absolute", () => {
    const result = resolveAppDataDir({ TELETOPAZ_DATA_DIR: "relative/path" });
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toContain("relative/path");
  });
});
