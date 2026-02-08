import os from "node:os";
import path from "node:path";

const SANDBOX_ENV = "TELETOPAZ_SANDBOX";
const SANDBOX_ACTIVE_ENV = "TELETOPAZ_SANDBOX_ACTIVE";

const DISABLE_VALUES = new Set(["0", "false", "off"]);

export function isSandboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[SANDBOX_ENV] ?? "").toLowerCase().trim();
  if (raw && DISABLE_VALUES.has(raw)) return false;
  return true;
}

export type SandboxProfileOptions = {
  workDir?: string;
  directoryPatterns?: string[];
};

/** Compute the narrowest common ancestor of a list of absolute paths. */
function commonAncestor(dirs: string[]): string | undefined {
  if (!dirs.length) return undefined;
  const split = dirs.map((d) => d.split(path.sep));
  const first = split[0]!;
  const parts: string[] = [];
  for (let i = 0; i < first.length; i++) {
    if (split.every((s) => s[i] === first[i])) {
      parts.push(first[i]!);
    } else {
      break;
    }
  }
  const ancestor = parts.join(path.sep) || path.sep;
  return ancestor === path.sep ? undefined : ancestor;
}

export function buildSandboxProfile(options?: SandboxProfileOptions): string {
  const home = os.homedir();

  // Determine writable project path: prefer explicit workDir, then common ancestor of patterns
  let projectWritePath: string | undefined = options?.workDir;
  if (!projectWritePath && options?.directoryPatterns?.length) {
    projectWritePath = commonAncestor(
      options.directoryPatterns.map((p) => path.resolve(p.replace(/\/?\*.*$/, "")))
    );
  }

  const lines = [
    "(version 1)",
    "(allow default)",
    "",
    "; deny global writes by default, only allow specific paths below",
    "(deny file-write* (subpath \"/\"))",
  ];

  if (projectWritePath) {
    lines.push(
      "",
      "; Allow writing only into the current session working directory",
      `(allow file-write* (subpath "${projectWritePath}"))`
    );
  }

  lines.push(
    "",
    "; Allow normal macOS temp/cache paths used by processes",
    "(allow file-write* (subpath \"/private/var/folders\"))",
    "(allow file-write* (subpath \"/var/folders\"))",
    "",
    "; Allow Copilot/CLI config write locations",
    `(allow file-write* (subpath "${home}/Library/Application Support/GitHub Copilot"))`,
    `(allow file-write* (subpath "${home}/.config/github-copilot"))`,
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
