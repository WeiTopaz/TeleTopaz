import { describe, it, expect } from "vitest";
import os from "node:os";
import { buildSandboxProfile, isSandboxEnabled } from "../src/sandbox-profile.js";

describe("sandbox profile", () => {
  it("enables sandbox by default", () => {
    expect(isSandboxEnabled({})).toBe(true);
  });

  it("allows explicit disable via env", () => {
    expect(isSandboxEnabled({ TELETOPAZ_SANDBOX: "0" })).toBe(false);
    expect(isSandboxEnabled({ TELETOPAZ_SANDBOX: "false" })).toBe(false);
    expect(isSandboxEnabled({ TELETOPAZ_SANDBOX: "off" })).toBe(false);
  });

  it("builds profile with dynamic home paths and PTY access", () => {
    const home = os.homedir();
    const profile = buildSandboxProfile({ workDir: "/tmp/test-project" });
    expect(profile).toContain("(version 1)");
    expect(profile).toContain("(allow default)");
    expect(profile).toContain("(deny file-write* (subpath \"/\"))");
    expect(profile).toContain("(allow file-write* (subpath \"/tmp/test-project\"))");
    expect(profile).toContain("(allow file-write* (subpath \"/private/var/folders\"))");
    expect(profile).toContain("(allow file-write* (subpath \"/var/folders\"))");
    expect(profile).toContain(`(allow file-write* (subpath "${home}/Library/Application Support/GitHub Copilot"))`);
    expect(profile).toContain(`(allow file-write* (subpath "${home}/.config/github-copilot"))`);
    expect(profile).toContain("(allow file-read* (subpath \"/dev/ptmx\"))");
    expect(profile).toContain("(allow file-write* (subpath \"/dev/ptmx\"))");
    expect(profile).toContain("(allow file-read* (subpath \"/dev/pts\"))");
  });

  it("computes common ancestor from directory patterns", () => {
    const profile = buildSandboxProfile({
      directoryPatterns: ["/Users/test/Project/*", "/Users/test/Project/sub/*"]
    });
    expect(profile).toContain("(allow file-write* (subpath \"/Users/test/Project\"))");
  });

  it("omits project write rule when no workDir or patterns", () => {
    const profile = buildSandboxProfile();
    expect(profile).not.toContain("current session working directory");
    expect(profile).toContain("(deny file-write* (subpath \"/\"))");
  });
});
