import os from "node:os";
import path from "node:path";
import { resolveAppDataDir } from "./util/app-data.js";

const SANDBOX_ENV = "TELETOPAZ_SANDBOX";
const SANDBOX_ACTIVE_ENV = "TELETOPAZ_SANDBOX_ACTIVE";

export function isSandboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  void env;
  return true;
}

export type SandboxProfileOptions = {
  workDir?: string;
  directoryPatterns?: string[];
};

function getPatternWriteRoots(directoryPatterns: string[]): string[] {
  const roots = new Set<string>();

  for (const rawPattern of directoryPatterns) {
    const normalized = rawPattern.replace(/\\/g, "/").trim();
    if (!normalized) continue;

    const globIndex = normalized.search(/[*?[{]/);
    const prefix = globIndex >= 0 ? normalized.slice(0, globIndex) : normalized;
    const trimmed = prefix.replace(/\/+$/, "");
    if (!trimmed) continue;

    roots.add(path.resolve(trimmed));
  }

  return Array.from(roots).sort();
}

/** Sensitive paths that should be denied for reading even though we allow reads globally. */
const SENSITIVE_READ_PATHS = [
  "/etc/shadow",
  "/etc/master.passwd",
  "/private/etc/master.passwd",
  "/var/db/dslocal",
];

export function buildSandboxProfile(options?: SandboxProfileOptions): string {
  const home = os.homedir();
  const appDataDir = resolveAppDataDir();

  const projectWriteRoots = options?.directoryPatterns?.length
    ? getPatternWriteRoots(options.directoryPatterns)
    : options?.workDir
      ? [path.resolve(options.workDir)]
      : [];

  const lines = [
    "(version 1)",
    "(allow default)",
    "",
    "; ── Read policy: allow all reads, deny sensitive paths ──",
    "(allow file-read*)",
    "",
    ...SENSITIVE_READ_PATHS.map((p) => `(deny file-read* (literal "${p}"))`),
    `(deny file-read* (subpath "${home}/.ssh"))`,
    `(deny file-read* (subpath "${home}/.gnupg"))`,
    "",
    "; ── Write policy: deny all writes, allow project + essential paths ──",
    "(deny file-write* (subpath \"/\"))",
  ];

  if (projectWriteRoots.length > 0) {
    lines.push("", "; Allow writing into TELETOPAZ_DIRECTORY_PATTERNS roots");
    for (const root of projectWriteRoots) {
      lines.push(`(allow file-write* (subpath "${root}"))`);
    }
  }

  lines.push(
    "",
    "; Allow normal macOS temp/cache paths used by processes",
    "(allow file-write* (subpath \"/private/var/folders\"))",
    "(allow file-write* (subpath \"/var/folders\"))",
    `(allow file-write* (subpath "${appDataDir}"))`,
    "",
    "; Allow macOS Keychain writes (so 'Always Allow' ACL updates persist)",
    `(allow file-write* (subpath "${home}/Library/Keychains"))`,
    "",
    "; Allow Copilot/CLI config write locations",
    `(allow file-write* (subpath "${home}/Library/Application Support/GitHub Copilot"))`,
    `(allow file-write* (subpath "${home}/.config/github-copilot"))`,
    `(allow file-write* (subpath "${home}/.gemini"))`,
    "",
    "; Allow PTY devices needed to spawn interactive child processes (minimal PTY access)",
    "(allow file-read* (subpath \"/dev/ptmx\"))",
    "(allow file-write* (subpath \"/dev/ptmx\"))",
    "(allow file-read* (subpath \"/dev/pts\"))"
  );

  return lines.join("\n");
}

export function getSandboxEnvName(): string {
  return SANDBOX_ENV;
}

export function isSandboxActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[SANDBOX_ACTIVE_ENV]);
}

export function getSandboxProfilePathHint(): string {
  return path.join("/tmp", "teletopaz-sandbox-<pid>.sb");
}
