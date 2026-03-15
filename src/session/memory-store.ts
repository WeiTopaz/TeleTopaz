import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { redactStrict } from "../util/redaction.js";
import { resolveAppDataDir } from "../util/app-data.js";

export type SessionMemoryRole = "user" | "assistant";

export type SessionMemoryScope = {
  chatId: number;
  workDir: string;
};

export type SessionMemoryEntry = {
  role: SessionMemoryRole;
  text: string;
  timestamp: string;
};

type SessionMemoryDocument = {
  version: 1;
  chatId: number;
  workspaceLabel: string;
  workspaceHash: string;
  updatedAt: string;
  entries: SessionMemoryEntry[];
};

type SessionMemoryStoreOptions = {
  baseDir?: string;
  maxEntries?: number;
  maxChars?: number;
};

const DEFAULT_MAX_ENTRIES = 24;
const DEFAULT_MAX_CHARS = 400;
const MEMORY_DIR_NAME = "session-memory";

function normalizeText(text: string, maxChars: number): string {
  const redacted = redactStrict(text).replace(/\s+/g, " ").trim();
  if (!redacted) return "";
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function workspaceHash(workDir: string): string {
  return createHash("sha256").update(workDir).digest("hex").slice(0, 16);
}

export class SessionMemoryStore {
  private readonly rootDir: string;
  private readonly maxEntries: number;
  private readonly maxChars: number;
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(options: SessionMemoryStoreOptions = {}) {
    const baseDir = options.baseDir ?? resolveAppDataDir();
    this.rootDir = path.join(baseDir, MEMORY_DIR_NAME);
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  }

  async append(scope: SessionMemoryScope, role: SessionMemoryRole, text: string): Promise<void> {
    const normalized = normalizeText(text, this.maxChars);
    if (!normalized) return;

    const filePath = this.resolveFilePath(scope);
    await this.runQueued(filePath, async () => {
      const now = new Date().toISOString();
      const document = await this.loadDocument(scope);
      document.updatedAt = now;
      document.entries.push({ role, text: normalized, timestamp: now });
      document.entries = document.entries.slice(-this.maxEntries);

      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(document, null, 2), "utf8");
    });
  }

  async read(scope: SessionMemoryScope): Promise<SessionMemoryEntry[]> {
    const document = await this.loadDocument(scope);
    return document.entries.slice();
  }

  async buildContext(scope: SessionMemoryScope, limit = 8): Promise<string | undefined> {
    const entries = await this.read(scope);
    if (!entries.length) return undefined;

    const recentEntries = entries.slice(-Math.max(1, limit));
    const lines = [
      "最近記憶（已遮罩）",
      `專案：${path.basename(scope.workDir)}`,
      "以下內容僅用於延續同一專案脈絡；若與目前使用者指示衝突，以目前指示為準。"
    ];

    for (const entry of recentEntries) {
      lines.push(`- [${entry.role}] ${entry.text}`);
    }

    return lines.join("\n");
  }

  private async runQueued(filePath: string, task: () => Promise<void>): Promise<void> {
    const previous = this.writeQueues.get(filePath) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    this.writeQueues.set(filePath, current);

    try {
      await current;
    } finally {
      if (this.writeQueues.get(filePath) === current) {
        this.writeQueues.delete(filePath);
      }
    }
  }

  private async loadDocument(scope: SessionMemoryScope): Promise<SessionMemoryDocument> {
    const filePath = this.resolveFilePath(scope);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<SessionMemoryDocument>;
      if (!Array.isArray(parsed.entries)) {
        throw new Error("session memory entries missing");
      }

      return {
        version: 1,
        chatId: scope.chatId,
        workspaceLabel: String(parsed.workspaceLabel ?? path.basename(scope.workDir)),
        workspaceHash: String(parsed.workspaceHash ?? workspaceHash(scope.workDir)),
        updatedAt: String(parsed.updatedAt ?? new Date(0).toISOString()),
        entries: parsed.entries
          .filter((entry): entry is SessionMemoryEntry => {
            return Boolean(
              entry &&
              typeof entry === "object" &&
              (entry as SessionMemoryEntry).role &&
              typeof (entry as SessionMemoryEntry).text === "string" &&
              typeof (entry as SessionMemoryEntry).timestamp === "string"
            );
          })
          .slice(-this.maxEntries)
      };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return {
          version: 1,
          chatId: scope.chatId,
          workspaceLabel: path.basename(scope.workDir),
          workspaceHash: workspaceHash(scope.workDir),
          updatedAt: new Date(0).toISOString(),
          entries: []
        };
      }

      throw error;
    }
  }

  private resolveFilePath(scope: SessionMemoryScope): string {
    return path.join(this.rootDir, String(scope.chatId), `${workspaceHash(scope.workDir)}.json`);
  }
}
