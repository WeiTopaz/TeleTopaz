import type { WaMessageKey } from "./client.js";
import type { BaseSessionState, BasePendingTask } from "../session/base-state.js";

export interface WaAttachment {
  filePath: string;
  mime: string;
}

export interface WaPendingTask extends BasePendingTask {
  attachments: WaAttachment[];
}

export interface WaRecovery {
  prompt: string;
  attachments: WaAttachment[];
}

export interface WaToolTracking {
  toolName: string;
  callId: string;
  msgKey: WaMessageKey | undefined;
  startTime: number;
}

export interface WaState extends BaseSessionState {
  // Narrowed types
  workDir: string;
  model: string;
  pendingTasks: WaPendingTask[];

  // WhatsApp-specific fields
  lastPrompt: string | undefined;
  lastReply: string | undefined;
  pendingRecovery: WaRecovery | undefined;
  toolMessageMap: Map<string, WaToolTracking>;
  currentAttachments: WaAttachment[];
}
