import { promises as fs } from "node:fs";
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
    const matches = await fg(normalized, { dot: false, onlyDirectories: true, unique: true });
    for (const match of matches) {
      const trimmed = match.replace(/\/+$/, "");
      try {
        const stat = await fs.stat(trimmed);
        if (!stat.isDirectory()) continue;
        const abs = path.resolve(trimmed);
        results.add(abs);
      } catch {
        continue;
      }
    }
  }

  return Array.from(results).sort();
}

export function isAllowedDirectory(allowed: string[], target: string): boolean {
  const resolvedTarget = path.resolve(target);
  const normalizedTarget = process.platform === "win32" ? resolvedTarget.toLowerCase() : resolvedTarget;
  for (const dir of allowed) {
    const resolved = path.resolve(dir);
    const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (normalized === normalizedTarget) return true;
  }
  return false;
}
