import { CopilotSdkClient, CopilotSdkSession, CopilotEvent } from "../copilot/sdk.js";

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
  client: CopilotSdkClient | undefined;
  session: CopilotSdkSession | undefined;
  workDir: string | undefined;
  engine: string | undefined;
  processing: boolean;
  pendingTasks: PendingTask[];
  resetting: boolean;
  attachments: Attachment[];
  sessionIcon: string;
  activePrompt: string | undefined;
  toolMessageMap: Map<string, ToolTracking>;
  awaitingReply: boolean;
  completionPending: boolean;
  pendingEvents: CopilotEvent[];
  dispatchingEvents: boolean;
  replyToMessageId: number | undefined;
  processingMessageId: number | undefined;
  processingTimer: NodeJS.Timeout | undefined;
  receivedAssistantMessage: boolean;
  lastAssistantMessageHash: string | undefined;
  promptCycles: number;
  starredEngines: string[];
  cachedDirs: string[];
  personaLoaded: boolean;
  reactionEmojis: string[] | null;
};
