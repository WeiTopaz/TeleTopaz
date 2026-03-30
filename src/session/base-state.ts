import type { AiClient, AiSession, ProviderType } from "../provider/types.js";

export interface BasePendingTask {
  prompt: string;
  queuedAt: number;
}

export interface BaseSessionState {
  // Provider
  provider: ProviderType;
  client: AiClient | undefined;
  session: AiSession | undefined;
  workDir: string | undefined;
  model: string | undefined;
  mode: "manual" | "auto";
  routerModel: string | undefined;
  coreModel: string | undefined;

  // Processing
  processing: boolean;
  pendingTasks: BasePendingTask[];
  promptCycles: number;

  // Session Lifecycle
  sessionCreatedAt: number | undefined;
  sessionLastActivityAt: number | undefined;

  // Flags
  allowAll: boolean;
  silentMode: boolean;
}
