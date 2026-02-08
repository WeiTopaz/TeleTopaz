import path from "node:path";

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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
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
  for (const name of candidates) {
    try {
      const mod = (await import(name)) as { CopilotClient?: new (options: Record<string, unknown>) => CopilotClientLike };
      if (mod.CopilotClient) {
        return { CopilotClient: mod.CopilotClient };
      }
    } catch {
      continue;
    }
  }
  throw new Error("Copilot SDK not installed. Install @github/copilot-sdk or @github/copilot-cli-sdk.");
}

export class CopilotSdkClient {
  private client: CopilotClientLike | undefined;

  async start(): Promise<void> {
    const { CopilotClient } = await loadCopilotSdk();
    const client = new CopilotClient({ auth: { type: "device" } });
    await client.start();
    this.client = client;
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
      ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {})
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
