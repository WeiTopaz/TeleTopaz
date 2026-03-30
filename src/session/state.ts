import type { AiAttachment, AiEvent } from "../provider/types.js";
import type { BaseSessionState, BasePendingTask } from "./base-state.js";

export type PendingTask = BasePendingTask;

export type Attachment = {
  dataUrl: string;
  mime: string;
  filePath?: string;
  addedAt: number;
};

export type ToolTracking = {
  messageId: number;
  resultKey: string;
  paramsKey: string;
  toolName?: string;
  callId?: string;
};

export type PendingRecovery = {
  id: string;
  prompt: string;
  replyToMessageId?: number;
  aiAttachments?: AiAttachment[];
  createdAt: number;
};

export interface AgentContext extends BaseSessionState {
  // Telegram-specific identity
  chatId: number;

  // Telegram-specific processing state
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
  pendingRecovery: PendingRecovery | undefined;
  lastProactiveRebuildNotice: {
    messageId: number;
    count: number;
  } | undefined;
  starredModels: string[];
  cachedDirs: string[];
  personaLoaded: boolean;
  reactionEmojis: string[] | null;
  silentAnchorMessageId: number | undefined;
  sessionVersion: number;

  // Narrowed from BaseSessionState
  pendingTasks: PendingTask[];
}
