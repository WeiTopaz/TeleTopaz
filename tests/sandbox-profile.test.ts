import { describe, it, expect } from "vitest";
import os from "node:os";
import { buildSandboxProfile, isSandboxEnabled } from "../src/sandbox-profile.js";

describe("sandbox profile", () => {
  it("enables sandbox by default", () => {
    expect(isSandboxEnabled({})).toBe(true);
  });

  it("forces sandbox even when env tries to disable it", () => {
    expect(isSandboxEnabled({ TELETOPAZ_SANDBOX: "0" })).toBe(true);
    expect(isSandboxEnabled({ TELETOPAZ_SANDBOX: "false" })).toBe(true);
    expect(isSandboxEnabled({ TELETOPAZ_SANDBOX: "off" })).toBe(true);
  });

  it("builds profile with dynamic home paths and PTY access", () => {
    const home = os.homedir();
    const uid = os.userInfo().uid;
    const profile = buildSandboxProfile({ workDir: "/tmp/test-project" });
    expect(profile).toContain("(version 1)");
    expect(profile).toContain("(allow default)");
    expect(profile).toContain("(allow file-read*)");
    expect(profile).toContain('(deny file-read* (literal "/etc/shadow"))');
    expect(profile).toContain(`(deny file-read* (subpath "${home}/.ssh"))`);
    expect(profile).toContain(`(deny file-read* (subpath "${home}/.gnupg"))`);
    expect(profile).toContain("(deny file-write* (subpath \"/\"))");
    expect(profile).toContain("(allow file-write* (subpath \"/tmp/test-project\"))");
    expect(profile).toContain("(allow file-write* (subpath \"/private/var/folders\"))");
    expect(profile).toContain("(allow file-write* (subpath \"/var/folders\"))");
    expect(profile).toContain(`(allow file-write* (subpath "/private/tmp/claude-${uid}"))`);
    expect(profile).toContain(`(allow file-write* (subpath "/tmp/claude-${uid}"))`);
    expect(profile).toContain(`(allow file-write* (subpath "${home}/.teletopaz"))`);
    expect(profile).toContain(`(allow file-write* (subpath "${home}/Library/Application Support/GitHub Copilot"))`);
    expect(profile).toContain(`(allow file-write* (subpath "${home}/.config/github-copilot"))`);
    expect(profile).toContain(`(allow file-write* (subpath "${home}/.copilot"))`);
    expect(profile).toContain(`(allow file-write* (subpath "${home}/.codex"))`);
    expect(profile).toContain(`(allow file-write* (subpath "${home}/.claude"))`);
    expect(profile).toContain(`(allow file-write* (literal "${home}/.claude.json"))`);
    expect(profile).toContain(`(allow file-write* (subpath "${home}/Library/Application Support/Claude"))`);
    expect(profile).toContain("(allow file-read* (subpath \"/dev/ptmx\"))");
    expect(profile).toContain("(allow file-write* (subpath \"/dev/ptmx\"))");
    expect(profile).toContain("(allow file-read* (subpath \"/dev/pts\"))");
  });

  it("allows /dev/null for subprocesses that rely on it", () => {
    const profile = buildSandboxProfile({ workDir: "/tmp/test-project" });

    expect(profile).toContain("(allow file-read* (subpath \"/dev/null\"))");
    expect(profile).toContain("(allow file-write* (subpath \"/dev/null\"))");
  });

  it("allows each TELETOPAZ_DIRECTORY_PATTERNS root without broadening to a shared ancestor", () => {
    const profile = buildSandboxProfile({
      directoryPatterns: ["/Users/test/Project/*", "/Users/test/Workspaces/*"]
    });
    expect(profile).toContain("(allow file-write* (subpath \"/Users/test/Project\"))");
    expect(profile).toContain("(allow file-write* (subpath \"/Users/test/Workspaces\"))");
    expect(profile).not.toContain("(allow file-write* (subpath \"/Users/test\"))");
  });

  it("prefers TELETOPAZ_DIRECTORY_PATTERNS roots over a selected child workDir", () => {
    const profile = buildSandboxProfile({
      workDir: "/Users/test/Project/existing-app",
      directoryPatterns: ["/Users/test/Project/*"]
    });

    expect(profile).toContain("(allow file-write* (subpath \"/Users/test/Project\"))");
    expect(profile).not.toContain("(allow file-write* (subpath \"/Users/test/Project/existing-app\"))");
  });

  it("omits project write rule when no workDir or patterns", () => {
    const profile = buildSandboxProfile();
    expect(profile).not.toContain("project working directory");
    expect(profile).toContain("(deny file-write* (subpath \"/\"))");
    expect(profile).toContain("(allow file-read*)");
  });
});
