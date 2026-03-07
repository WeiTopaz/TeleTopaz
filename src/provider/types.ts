export type ProviderType = "copilot" | "gemini";

export type AiEvent = {
  type?: string;
  data?: unknown;
  [key: string]: unknown;
};

export type AiSessionOptions = {
  model: string;
  systemPrompt?: string;
  hooks?: Record<string, unknown>;
  workingDirectory?: string;
  skillDirectories?: string[];
  approvalMode?: "default" | "auto_edit" | "yolo" | "plan";
};

export type AiProviderInfo = {
  version?: string;
  protocolVersion?: string;
  authStatus?: string;
  user?: string;
  models?: string[];
  modelsRaw?: unknown[];
  error?: string;
};

export interface AiClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  createSession(options: AiSessionOptions): Promise<AiSession>;
  queryProviderInfo(): Promise<AiProviderInfo>;
}

export interface AiSession {
  onEvent(handler: (event: AiEvent) => void): void;
  send(prompt: string): Promise<void>;
  sendAndWait(prompt: string, timeoutMs?: number): Promise<unknown>;
  destroy(): Promise<void>;
  abort(): Promise<void>;
}
