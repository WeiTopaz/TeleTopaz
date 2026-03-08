import type { AiClient, AiSession, AiEvent, ProviderType } from "../provider/types.js";

export type PendingTask = {
  prompt: string;
  queuedAt: number;
};

export type Attachment = {
  dataUrl: string;
  mime: string;
  addedAt: number;
};

export type ToolTracking = {
  messageId: number;
  resultKey: string;
  paramsKey: string;
  toolName?: string;
  callId?: string;
};

export type AgentContext = {
  chatId: number;
  provider: ProviderType;
  client: AiClient | undefined;
  session: AiSession | undefined;
  workDir: string | undefined;
  model: string | undefined;
  mode: "manual" | "auto";
  routerModel: string | undefined;
  coreModel: string | undefined;
  processing: boolean;
  pendingTasks: PendingTask[];
  resetting: boolean;
  attachments: Attachment[];
  sessionIcon: string;
  activePrompt: string | undefined;
  toolMessageMap: Map<string, ToolTracking>;
  awaitingReply: boolean;
  completionPending: boolean;
  pendingEvents: AiEvent[];
  dispatchingEvents: boolean;
  replyToMessageId: number | undefined;
  processingMessageId: number | undefined;
  processingTimer: NodeJS.Timeout | undefined;
  receivedAssistantMessage: boolean;
  lastAssistantMessageHash: string | undefined;
  lastAssistantMessageText: string | undefined;
  promptCycles: number;
  starredModels: string[];
  cachedDirs: string[];
  personaLoaded: boolean;
  reactionEmojis: string[] | null;
  allowAll: boolean;
};
