import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";

export async function loadDirectoryPatterns(override?: string): Promise<string[]> {
  if (override && override.trim()) {
    return override
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return [];
}

export async function expandDirectoryPatterns(patterns: string[]): Promise<string[]> {
  if (!patterns.length) return [];

  const results = new Set<string>();
  for (const pattern of patterns) {
    if (!pattern) continue;
    const normalized = pattern.replace(/\\/g, "/");
    const patternRoot = resolvePatternRoot(normalized);
    if (!patternRoot) continue;
    const canonicalPatternRoot = await canonicalizeDirectory(patternRoot);
    let matches: string[];
    try {
      matches = await fg(normalized, { dot: false, onlyDirectories: true, unique: true });
    } catch {
      continue;
    }
    for (const match of matches) {
      const trimmed = match.replace(/\/+$/, "");
      try {
        const resolved = await canonicalizeDirectory(trimmed);
        const stat = await fs.stat(resolved);
        if (!stat.isDirectory()) continue;
        if (!isWithinDirectory(canonicalPatternRoot, resolved)) continue;
        results.add(resolved);
      } catch {
        continue;
      }
    }
  }

  return Array.from(results).sort();
}

export function isAllowedDirectory(allowed: string[], target: string): boolean {
  const resolvedTarget = canonicalizeDirectorySync(target);
  const normalizedTarget = process.platform === "win32" ? resolvedTarget.toLowerCase() : resolvedTarget;
  for (const dir of allowed) {
    const resolved = canonicalizeDirectorySync(dir);
    const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (normalized === normalizedTarget) return true;
  }
  return false;
}

async function canonicalizeDirectory(dir: string): Promise<string> {
  const resolved = path.resolve(dir);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

function canonicalizeDirectorySync(dir: string): string {
  const resolved = path.resolve(dir);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function resolvePatternRoot(pattern: string): string | undefined {
  const globIndex = pattern.search(/[*?[{]/);
  const prefix = globIndex >= 0 ? pattern.slice(0, globIndex) : pattern;
  const trimmed = prefix.replace(/\/+$/, "").trim();
  return trimmed ? path.resolve(trimmed) : undefined;
}

function isWithinDirectory(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
