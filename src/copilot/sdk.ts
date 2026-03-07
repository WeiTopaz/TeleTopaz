import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AiPermissionHandler } from "../provider/types.js";

export type CopilotEvent = {
  type?: string;
  data?: unknown;
  [key: string]: unknown;
};

export type CopilotSessionOptions = {
  model: string;
  systemPrompt?: string;
  hooks?: Record<string, unknown>;
  workingDirectory?: string;
  skillDirectories?: string[];
  approvalMode?: "default" | "auto_edit" | "yolo" | "plan";
  onPermissionRequest?: AiPermissionHandler;
};

export type CopilotProviderInfo = {
  version?: string;
  protocolVersion?: string;
  authStatus?: string;
  user?: string;
  models?: string[];
  modelsRaw?: unknown[];
  error?: string;
};

type CopilotSessionLike = {
  on?: ((event: string, handler: (event: CopilotEvent) => void) => void) | ((handler: (event: CopilotEvent) => void) => void);
  send?: (options: { prompt: string; attachments?: Array<{ type: string; path: string; displayName?: string }>; mode?: string }) => Promise<string>;
  sendAndWait?: (options: { prompt: string; attachments?: Array<{ type: string; path: string; displayName?: string }>; mode?: string }, timeout?: number) => Promise<unknown>;
  destroy?: () => Promise<void>;
  abort?: () => Promise<void>;
  events?: () => AsyncIterable<unknown>;
};

type CopilotClientLike = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  createSession: (options: Record<string, unknown>) => Promise<CopilotSessionLike>;
  getStatus?: () => Promise<unknown>;
  getAuthStatus?: () => Promise<unknown>;
  getModels?: () => Promise<unknown>;
  listModels?: () => Promise<unknown>;
  getVersion?: () => Promise<unknown>;
};

export type CopilotModelInfo = {
  name: string;
  provider?: string;
};

const PROTOCOL_VERSION_MISMATCH_RE =
  /SDK protocol version mismatch: SDK expects version (\d+), but server reports version (\d+)/i;
const PROTOCOL_VERSION_MISSING_RE =
  /SDK protocol version mismatch: SDK expects version (\d+), but server does not report a protocol version/i;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

export function normalizeCopilotStartError(error: unknown): Error {
  const baseError = error instanceof Error ? error : new Error(String(error));
  const mismatch = baseError.message.match(PROTOCOL_VERSION_MISMATCH_RE);
  if (mismatch) {
    const [, expectedVersion, serverVersion] = mismatch;
    return new Error(
      `Copilot SDK 與 CLI 協定版本不相容（SDK=${expectedVersion}，server=${serverVersion}）。請更新專案的 @github/copilot-sdk 後重新安裝相依套件再試一次。`,
      { cause: baseError }
    );
  }

  const missingVersion = baseError.message.match(PROTOCOL_VERSION_MISSING_RE);
  if (missingVersion) {
    const [, expectedVersion] = missingVersion;
    return new Error(
      `Copilot SDK 與 CLI 協定版本不相容（SDK=${expectedVersion}，server=unknown）。請更新專案的 @github/copilot-sdk 後重新安裝相依套件再試一次。`,
      { cause: baseError }
    );
  }

  return baseError;
}

function findNodeModulesRoot(entryPath: string): string | undefined {
  let current = path.dirname(path.resolve(entryPath));
  while (true) {
    if (path.basename(current) === "node_modules") return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureVscodeJsonrpcNodeShim(nodeModulesRoot: string): Promise<boolean> {
  const packageDir = path.join(nodeModulesRoot, "vscode-jsonrpc");
  const shimPath = path.join(packageDir, "node");
  const targetPath = path.join(packageDir, "node.js");

  if (await pathExists(shimPath)) return false;
  if (!await pathExists(targetPath)) return false;

  try {
    await fs.writeFile(
      shimPath,
      "module.exports = require('./node.js');\n",
      { encoding: "utf8", flag: "wx" }
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }

  return true;
}

export function normalizeModelInfos(models: unknown[]): CopilotModelInfo[] {
  const result: CopilotModelInfo[] = [];
  for (const model of models) {
    if (typeof model === "string") {
      result.push({ name: model });
      continue;
    }
    const record = asRecord(model);
    if (!record) continue;
    const nameCandidate =
      (typeof record.id === "string" && record.id) ||
      (typeof record.name === "string" && record.name) ||
      (typeof record.model === "string" && record.model) ||
      (typeof record.modelId === "string" && record.modelId) ||
      (typeof record.slug === "string" && record.slug);
    if (!nameCandidate) continue;
    const providerCandidate =
      (typeof record.provider === "string" && record.provider) ||
      (typeof record.vendor === "string" && record.vendor) ||
      (typeof record.owner === "string" && record.owner) ||
      (typeof record.source === "string" && record.source) ||
      (typeof record.publisher === "string" && record.publisher) ||
      (typeof record.company === "string" && record.company);
    const info: CopilotModelInfo = { name: nameCandidate };
    if (providerCandidate) info.provider = providerCandidate;
    result.push(info);
  }
  return result;
}

async function loadCopilotSdk(): Promise<{ CopilotClient: new (options: Record<string, unknown>) => CopilotClientLike }> {
  const candidates = ["@github/copilot-sdk", "@github/copilot-cli-sdk"] as const;
  let lastLoadError: unknown;

  for (const name of candidates) {
    try {
      const entryUrl = await import.meta.resolve(name);
      const entryPath = fileURLToPath(entryUrl);
      const nodeModulesRoot = findNodeModulesRoot(entryPath);
      if (nodeModulesRoot) {
        await ensureVscodeJsonrpcNodeShim(nodeModulesRoot);
      }

      const mod = (await import(entryUrl)) as { CopilotClient?: new (options: Record<string, unknown>) => CopilotClientLike };
      if (mod.CopilotClient) {
        return { CopilotClient: mod.CopilotClient };
      }
      lastLoadError = new Error(`Copilot SDK 載入成功但缺少 CopilotClient 匯出：${name}`);
    } catch (error) {
      lastLoadError = error;
      continue;
    }
  }

  if (lastLoadError) {
    const baseError = lastLoadError instanceof Error ? lastLoadError : new Error(String(lastLoadError));
    throw new Error(`Copilot SDK 載入失敗：${baseError.message}`, { cause: baseError });
  }

  throw new Error("Copilot SDK not installed. Install @github/copilot-sdk or @github/copilot-cli-sdk.");
}

export class CopilotSdkClient {
  private client: CopilotClientLike | undefined;

  async start(): Promise<void> {
    const { CopilotClient } = await loadCopilotSdk();
    const client = new CopilotClient({ auth: { type: "device" } });
    try {
      await client.start();
      this.client = client;
    } catch (error) {
      throw normalizeCopilotStartError(error);
    }
  }

  async stop(): Promise<void> {
    if (this.client) {
      await this.client.stop();
      this.client = undefined;
    }
  }

  async createSession(options: CopilotSessionOptions): Promise<CopilotSdkSession> {
    if (!this.client) {
      throw new Error("Copilot client not started");
    }

    const sessionOptions: Record<string, unknown> = {
      model: options.model,
      ...(options.systemPrompt ? { systemMessage: { content: options.systemPrompt } } : {}),
      ...(options.hooks ? { hooks: options.hooks } : {}),
      ...(options.approvalMode ? { approvalMode: options.approvalMode } : {}),
      ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
      ...(options.skillDirectories?.length ? { skillDirectories: options.skillDirectories } : {}),
      ...(options.onPermissionRequest ? { onPermissionRequest: options.onPermissionRequest } : {})
    };

    const session = await this.client.createSession(sessionOptions);
    return new CopilotSdkSession(session);
  }

  async queryProviderInfo(): Promise<CopilotProviderInfo> {
    if (!this.client) {
      throw new Error("Copilot client not started");
    }

    const info: CopilotProviderInfo = {};
    try {
      const version = this.client.getVersion ? await this.client.getVersion() : undefined;
      if (typeof version === "string") info.version = version;
    } catch {
      // ignore
    }

    try {
      const status = this.client.getStatus ? await this.client.getStatus() : undefined;
      if (status && typeof status === "object" && "protocolVersion" in status) {
        const protocol = (status as Record<string, unknown>).protocolVersion;
        if (protocol !== undefined && protocol !== null) {
          info.protocolVersion = String(protocol);
        }
      }
    } catch {
      // ignore
    }

    try {
      const auth = this.client.getAuthStatus ? await this.client.getAuthStatus() : undefined;
      if (auth && typeof auth === "object") {
        const record = auth as Record<string, unknown>;
        if (record.status) info.authStatus = String(record.status);
        if (record.user) info.user = String(record.user);
      }
    } catch {
      // ignore
    }

    try {
      const models = this.client.getModels
        ? await this.client.getModels()
        : this.client.listModels
          ? await this.client.listModels()
          : undefined;
      if (Array.isArray(models)) {
        info.modelsRaw = models;
        info.models = normalizeModelInfos(models).map((item) => item.name);
      } else if (models && typeof models === "object" && "models" in models) {
        const list = (models as Record<string, unknown>).models;
        if (Array.isArray(list)) {
          info.modelsRaw = list;
          info.models = normalizeModelInfos(list).map((item) => item.name);
        }
      }
    } catch {
      // ignore
    }

    return info;
  }
}

export class CopilotSdkSession {
  private session: CopilotSessionLike;

  constructor(session: CopilotSessionLike) {
    this.session = session;
  }

  onEvent(handler: (event: CopilotEvent) => void): void {
    let hooked = false;
    if (this.session.on) {
      try {
        (this.session.on as (handler: (event: CopilotEvent) => void) => void)((event) => handler(event));
        hooked = true;
      } catch {
        // ignore
      }
      if (!hooked) {
        const eventNames = [
          "assistant.message",
          "assistant.message_delta",
          "tool.execution_start",
          "tool.execution_complete",
          "session.idle"
        ];
        for (const name of eventNames) {
          try {
            (this.session.on as (event: string, handler: (event: CopilotEvent) => void) => void)(name, (event) => {
              if (name === "session.idle") {
                handler({ type: "session.idle", data: event });
                return;
              }
              handler(event);
            });
            hooked = true;
          } catch {
            // ignore
          }
        }
      }
    }

    if (typeof this.session.events === "function") {
      hooked = true;
      const iterable = this.session.events();
      (async () => {
        try {
          for await (const event of iterable) {
            if (event && typeof event === "object") {
              const record = event as Record<string, unknown>;
              handler({ type: (record.type as string) ?? (record.event as string), data: record });
            } else {
              handler({ data: event });
            }
          }
        } catch {
          // ignore
        }
      })();
    }

    if (!hooked) {
      // no event mechanism available
    }
  }

  async send(prompt: string): Promise<void> {
    if (!this.session.send) {
      throw new Error("Copilot session does not support send");
    }
    await this.session.send({ prompt });
  }

  async sendAndWait(prompt: string, timeoutMs?: number): Promise<unknown> {
    if (!this.session.sendAndWait) {
      throw new Error("Copilot session does not support sendAndWait");
    }
    return this.session.sendAndWait({ prompt }, timeoutMs);
  }

  async destroy(): Promise<void> {
    if (this.session.destroy) {
      await this.session.destroy();
      return;
    }
    if (this.session.abort) {
      await this.session.abort();
    }
  }

  async abort(): Promise<void> {
    if (this.session.abort) {
      await this.session.abort();
      return;
    }
    if (this.session.destroy) {
      await this.session.destroy();
    }
  }
}
