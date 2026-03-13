export type ProviderType = "copilot" | "gemini";

export type AiEvent = {
  type?: string;
  data?: unknown;
  [key: string]: unknown;
};

export type AiShellPermissionRequest = {
  kind: "shell";
  toolCallId?: string;
  fullCommandText: string;
  intention: string;
};

export type AiWritePermissionRequest = {
  kind: "write";
  toolCallId?: string;
  intention: string;
  fileName: string;
  diff: string;
  newFileContents?: string;
};

export type AiMcpPermissionRequest = {
  kind: "mcp";
  toolCallId?: string;
  serverName: string;
  toolName: string;
  toolTitle: string;
  args?: unknown;
  readOnly: boolean;
};

export type AiReadPermissionRequest = {
  kind: "read";
  toolCallId?: string;
  intention: string;
  path: string;
};

export type AiUrlPermissionRequest = {
  kind: "url";
  toolCallId?: string;
  intention: string;
  url: string;
};

export type AiMemoryPermissionRequest = {
  kind: "memory";
  toolCallId?: string;
  subject: string;
  fact: string;
  citations: string;
};

export type AiCustomToolPermissionRequest = {
  kind: "custom-tool";
  toolCallId?: string;
  toolName: string;
  toolDescription: string;
  args?: unknown;
};

export type AiPermissionRequest =
  | AiShellPermissionRequest
  | AiWritePermissionRequest
  | AiMcpPermissionRequest
  | AiReadPermissionRequest
  | AiUrlPermissionRequest
  | AiMemoryPermissionRequest
  | AiCustomToolPermissionRequest;

export type AiPermissionResult =
  | { kind: "approved" }
  | { kind: "denied-by-rules"; rules: ReadonlyArray<unknown> }
  | { kind: "denied-no-approval-rule-and-could-not-request-from-user" }
  | { kind: "denied-interactively-by-user"; feedback?: string }
  | { kind: "denied-by-content-exclusion-policy"; path: string; message: string };

export type AiPermissionHandler = (request: AiPermissionRequest) => Promise<AiPermissionResult> | AiPermissionResult;

export type AiSessionOptions = {
  model: string;
  systemPrompt?: string;
  hooks?: Record<string, unknown>;
  workingDirectory?: string;
  skillDirectories?: string[];
  approvalMode?: "default" | "auto_edit" | "yolo" | "plan";
  onPermissionRequest?: AiPermissionHandler;
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

export type AiAttachment = {
  type: string;
  path: string;
  displayName?: string;
};

export interface AiSession {
  onEvent(handler: (event: AiEvent) => void): void;
  send(prompt: string, attachments?: AiAttachment[]): Promise<void>;
  sendAndWait(prompt: string, timeoutMs?: number): Promise<unknown>;
  destroy(): Promise<void>;
  abort(): Promise<void>;
}
