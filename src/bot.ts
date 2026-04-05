import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TelegramApi } from "./telegram/api.js";
import { InlineKeyboardMarkup, TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from "./telegram/types.js";
import { loadConfiguredRuntimeConfig, loadSecrets } from "./config/secrets.js";
import { loadDirectoryPatterns, expandDirectoryPatterns, isAllowedDirectory } from "./config/directories.js";
import { loadGuardrails, evaluatePrompt, evaluatePromptWithOptions, guardToolOutput } from "./guardrails/guardrails.js";
import { redact } from "./util/redaction.js";
import { markdownToTelegram, splitLongMessage } from "./util/markdown.js";
import { formatChatDisplayName, formatJsonResult, parseIndex } from "./util/format.js";
import { logger } from "./util/logger.js";
import { parseFingerprints } from "./util/tls.js";
import { CopilotSdkClient, normalizeModelInfos } from "./copilot/sdk.js";
import { createProviderClient } from "./provider/factory.js";
import { quotaService } from "./services/quota.js";
import type {
  AiAttachment,
  AiClient,
  AiEvent,
  AiPermissionHandler,
  AiPermissionRequest,
  AiPermissionResult,
  AiSession,
  ProviderType
} from "./provider/types.js";
import { AgentContext, Attachment, ToolTracking, PendingTask } from "./session/state.js";
import { getIconPool, pickIcon } from "./session/emoji.js";
import { SessionMemoryStore } from "./session/memory-store.js";
import { buildPersonaPrompt } from "./session/persona.js";
import { buildPromptChunks, composePrompt } from "./session/prompt.js";
import { reencodePhoto } from "./util/images.js";
import {
  consumeRepeatedLog,
  extractNetworkErrorSummary,
  isConnectionDisposedError,
  isTelegramNotModifiedError,
  isTelegramReactionInvalid,
  isTransientTelegramNetworkError
} from "./util/errors.js";
import {
  EXIT_CODE_RESTART,
  type RestartState,
  clearRestartState,
  getGitInfo,
  loadRestartState,
  performGitRollback,
  saveRestartState,
} from "./restart.js";
import {
  DEFAULT_CORE_MODEL,
  DEFAULT_ROUTER_MODEL,
  formatModelEntry as formatConfiguredModelEntry,
  getAllModels,
  getDefaultModel,
  loadSupportedModels,
  normalizeModelEntry as normalizeConfiguredModelEntry,
  parseModelEntry as parseConfiguredModelEntry
} from "./config/models.js";

const MESSAGE_LIMIT = 4096;
const PENDING_LIMIT = 15;
const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};
const TOOL_PREVIEW_LEN = 150;
const POLLING_ERROR_DEDUPE_WINDOW_MS = 15_000;
const SESSION_IDLE_REBUILD_MS = 60 * 60 * 1000;
const SESSION_MAX_LIFETIME_MS = 10 * 60 * 60 * 1000;
/** Returns true when proactive-rebuild notifications should be suppressed (00:00–07:59 UTC+8). */
function isQuietHours(nowMs: number = Date.now()): boolean {
  const utc8Hour = (new Date(nowMs).getUTCHours() + 8) % 24;
  return utc8Hour < 8;
}

const ROUTER_MODEL_PATTERN = /(?:^|[-.])(mini|flash|lite|haiku)(?:$|[-.])/i;

interface ShortcutConfig {
  label: string;
  callbackKey: string;
  targetDirName: string;
  modelEntry: string;
}

const SHORTCUT_BUTTONS: ShortcutConfig[] = [
  {
    label: "📔 日記",
    callbackKey: "diary",
    targetDirName: "MyDiary",
    modelEntry: "ctcli:gpt-5-mini",
  },
  {
    label: "📓 筆記",
    callbackKey: "notebook",
    targetDirName: "MyNotebook",
    modelEntry: "cccli:claude-sonnet-4.6",
  },
];

type CreateSessionOptions = {
  announce?: boolean;
};

type SendPromptResult = {
  chunked: boolean;
  totalChunks: number;
  recovered?: boolean;
};

function resolveApprovalMode(provider: ProviderType, allowAll?: boolean): "plan" | "auto_edit" | "yolo" | undefined {
  if (provider === "gemini") return "plan";
  if (provider === "claude-code") return allowAll ? "yolo" : "auto_edit";
  return undefined;
}

/** Tool names that perform write or delete operations requiring human confirmation. */
const WRITE_DELETE_TOOLS = new Set([
  // Copilot SDK tool names (stored lowercase for case-insensitive lookup)
  "editfile", "createfile", "deletefile", "renamefile",
  // Gemini CLI tool names (snake_case)
  "write_file", "edit_file", "create_file", "delete_file",
  "rename_file", "move_file", "replace", "run_shell_command",
  // Generic / short names
  "write", "create", "edit", "delete", "remove", "rename",
  "shell", "bash", "terminal", "exec",
]);

/** Keyword segments that imply a write/delete side-effect. */
const WRITE_DELETE_KEYWORDS = new Set([
  "write", "delete", "remove", "create", "edit", "replace",
  "patch", "mv", "rm", "shell", "exec", "bash",
]);

const READ_ONLY_TOOLS = new Set([
  "readfile", "read_file", "cat", "grep", "glob", "listdir", "list_dir",
  "listfiles", "list_files", "search", "find", "view", "open"
]);

const READ_ONLY_KEYWORDS = new Set([
  "read", "cat", "grep", "glob", "list", "search", "find", "view", "open"
]);

const TOOL_PATH_KEY_RE = /(?:^|[_-])(path|paths|file|files|dir|dirs|directory|directories|cwd|root|glob|pattern)$/i;
const SECRET_FILE_BASENAME_RE =
  /^(?:\.env(?:\..+)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519))$/i;
const SECRET_PATH_SEGMENTS = new Set([".ssh", ".gnupg", ".aws", ".kube"]);

/** Returns true when the tool name implies a write/delete side-effect. */
function isWriteOrDeleteTool(name: string | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  if (WRITE_DELETE_TOOLS.has(lower)) return true;
  // Split by separators (underscore, hyphen, dot, space) and check segments
  const segments = lower.split(/[_\-.\s]+/);
  return segments.some(s => WRITE_DELETE_KEYWORDS.has(s));
}

function isReadOnlyTool(name: string | undefined): boolean {
  if (!name) return false;
  if (isWriteOrDeleteTool(name)) return false;
  const lower = name.toLowerCase();
  if (READ_ONLY_TOOLS.has(lower)) return true;
  const segments = lower.split(/[_\-.\s]+/);
  return segments.some((segment) => READ_ONLY_KEYWORDS.has(segment));
}

function collectToolPathCandidates(value: unknown, key?: string, depth = 0): string[] {
  if (depth > 4 || value == null) return [];
  if (typeof value === "string") {
    if (!key || TOOL_PATH_KEY_RE.test(key)) {
      return [value];
    }
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectToolPathCandidates(entry, key, depth + 1));
  }
  if (typeof value !== "object") return [];

  const result: string[] = [];
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    result.push(...collectToolPathCandidates(childValue, childKey, depth + 1));
  }
  return result;
}

function expandUserPath(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

async function resolveToolPath(rawPath: string, baseDir: string): Promise<string> {
  const expanded = expandUserPath(rawPath);
  const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
  try {
    return await fs.realpath(absolute);
  } catch {
    return path.resolve(absolute);
  }
}

function isWithinDirectory(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isSensitivePath(targetPath: string): boolean {
  const basename = path.basename(targetPath);
  if (SECRET_FILE_BASENAME_RE.test(basename)) return true;

  const segments = targetPath.split(path.sep).filter(Boolean);
  return segments.some((segment) => SECRET_PATH_SEGMENTS.has(segment));
}

async function getPathRestriction(
  rawPath: string,
  workspaceDir: string,
  baseDir = workspaceDir
): Promise<string | undefined> {
  const resolvedPath = await resolveToolPath(rawPath, baseDir);
  if (isSensitivePath(resolvedPath)) {
    return "敏感檔案需改用已確認的 shell / 編輯流程處理。";
  }
  if (!isWithinDirectory(workspaceDir, resolvedPath)) {
    return "讀取工具僅允許存取目前專案。";
  }
  return undefined;
}

async function getReadToolRestriction(
  toolName: string | undefined,
  toolArgs: unknown,
  workspaceDir: string,
  toolCwd?: string
): Promise<string | undefined> {
  if (!isReadOnlyTool(toolName)) return undefined;

  const candidates = collectToolPathCandidates(toolArgs);
  if (candidates.length === 0) return undefined;

  const baseDir = toolCwd ? await resolveToolPath(toolCwd, workspaceDir) : workspaceDir;
  for (const rawPath of candidates) {
    const restriction = await getPathRestriction(rawPath, workspaceDir, baseDir);
    if (restriction) return restriction;
  }

  return undefined;
}

function approvePermission(): AiPermissionResult {
  return { kind: "approved" };
}

function denyPermission(): AiPermissionResult {
  return { kind: "denied-no-approval-rule-and-could-not-request-from-user" };
}

function isRouterCandidateModel(model: string): boolean {
  return ROUTER_MODEL_PATTERN.test(model);
}

const TOOL_CONFIRM_TIMEOUT_MS = 120_000;
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLED_SKILLS_PATH = path.join(APP_ROOT, ".github", "skills");

function stripAttachmentContext(prompt: string): string {
  const marker = "\n\n附件圖片：\n";
  const index = prompt.indexOf(marker);
  return (index >= 0 ? prompt.slice(0, index) : prompt).trim();
}

const COMMANDS = [
  "/help",
  "/project",
  "/model",
  "/info",
  "/i",
  "/clear",
  "/router",
  "/allowall",
  "/silent",
  "/restart",
  "/quit"
];

type RouterSnapshot = {
  provider: ProviderType;
  model: string | undefined;
  mode: "manual" | "auto";
  client: AiClient | undefined;
  session: AiSession | undefined;
};

export class TeleTopazService {
  private readonly api: TelegramApi;
  private readonly ownerChatId: string;
  private readonly ownerUserId: string;
  private readonly startTimestamp: number;
  private readonly guardrailsPromise = loadGuardrails();
  private readonly states = new Map<number, AgentContext>();
  private readonly toolParams = new Map<string, string>();
  private readonly toolResults = new Map<string, string>();
  private readonly pendingToolConfirmations = new Map<string, { resolve: (allowed: boolean) => void }>();
  private readonly routerCompletionCallbacks = new Map<number, () => Promise<void>>();
  private readonly sessionMemory = new SessionMemoryStore();
  private modelsCache = new Map<ProviderType, { models: string[]; fetchedAt: number }>();
  private readonly modelsTtlMs = 5 * 60 * 1000;
  private readonly transientPollingErrorLogState = { suppressedCount: 0 };
  private intentClassifierClient: AiClient | undefined;
  private intentClassifierProvider: ProviderType | undefined;
  private running = true;
  private offset = 0;
  private shuttingDown = false;
  private restartConfirmTimer: NodeJS.Timeout | undefined;
  private restartConfirmMessageId: number | undefined;

  constructor(api: TelegramApi, ownerChatId: string, ownerUserId: string, startTimestamp: number) {
    this.api = api;
    this.ownerChatId = ownerChatId;
    this.ownerUserId = ownerUserId;
    this.startTimestamp = startTimestamp;
  }

  static async create(): Promise<TeleTopazService> {
    const secrets = await loadSecrets();
    const fingerprints = parseFingerprints(secrets.certificateFingerprints);
    const api = new TelegramApi({ token: secrets.botToken, fingerprints });
    return new TeleTopazService(api, secrets.ownerChatId, secrets.ownerUserId, Math.floor(Date.now() / 1000));
  }

  async start(): Promise<void> {
    const models = await this.getModels();
    const guardrails = await this.guardrailsPromise;
    logger.info("Guardrails loaded", guardrails.version);

    const directories = await this.loadAllowedDirectories();
    await this.ensureTempNoteDirectory(directories);
    const finalDirectories = await this.loadAllowedDirectories();
    logger.info("Allowed directory count", { count: finalDirectories.length });

    await this.clearOfflineUpdates();

    const providerInfo = await this.fetchProviderInfo();
    const defaultModel = getDefaultModel(models);
    const state = this.getOrCreateState(Number(this.ownerChatId));
    if (state.mode !== "auto" && !state.model && defaultModel) state.model = defaultModel;

    // Auto-select TempNote as default workDir
    const tempNoteDir = finalDirectories.find((d) => path.basename(d) === "TempNote");
    if (!state.workDir && tempNoteDir) {
      state.workDir = tempNoteDir;
      state.cachedDirs = finalDirectories;
      logger.info("Default workDir set to TempNote", tempNoteDir);
    }

    logger.info("Bot started at", Math.floor(Date.now() / 1000));
    logger.info("💎 TeleTopaz 已啟動");
    logger.info(`🗂️ ${finalDirectories.length} 個可用目錄`);
    if (defaultModel) {
      logger.info(`🤖 使用預設模型: ${defaultModel}`);
    }
    logger.info("✅ 可用命令：");
    logger.info("  /project - 選擇專案");
    logger.info("  /newproject - 建立新專案");
    logger.info("  /model - 切換模型 (Auto/Manual)");
    logger.info("  /info - 說明");
    logger.info("  /clear - 清除對話與附件");
    logger.info("  /router {prompt} - 使用 routerModel 執行單次對話，完成後自動還原");
    logger.info("  /allowall - 切換全部允許/操作確認模式");
    logger.info("  /silent - 切換安靜/正常通知模式");
    logger.info("  /restart - 熱啟動 (需搭配 start:hot)");
    logger.info("  /quit - 關閉Bot");
    logger.info("  /help - 顯示說明與指令列表");

    // Auto-create session if workDir and model ready
    const startupModel = state.mode === "auto" ? state.model : state.model ?? defaultModel;
    if (state.workDir && startupModel) {
      await this.createSession(Number(this.ownerChatId), state.workDir, startupModel);
    }

    try {
      await this.sendWelcome(providerInfo, finalDirectories, models);
      logger.info("Welcome message and provider info sent to owner");
    } catch (err) {
      logger.error("Welcome send failed", err);
    }

    this.poll().catch((err) => logger.error("Polling failed", err));
    process.on("SIGINT", () => {
      if (this.shuttingDown) {
        process.exit(0);
      }
      this.shuttingDown = true;
      this.running = false;
      setTimeout(() => process.exit(0), 4000);
      this.shutdown().catch((err) => logger.error("Shutdown failed", err));
    });
    process.on("unhandledRejection", (reason) => {
      if (this.shuttingDown && isConnectionDisposedError(reason)) return;
      logger.error("Unhandled rejection", reason);
    });
    process.on("uncaughtException", (err) => {
      logger.error("Uncaught exception", err);
    });

    // Hot-restart confirmation check
    await this.checkRestartConfirmation();
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.api.getUpdates(this.offset, 25);
        await this.checkSessionHealth().catch((err) => {
          logger.warn("Session health check failed", err);
        });
        if (updates.length === 0) {
          continue;
        }
        for (const update of updates) {
          this.offset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (err) {
        const summary = extractNetworkErrorSummary(err);
        if (summary && isTransientTelegramNetworkError(err)) {
          const decision = consumeRepeatedLog(
            this.transientPollingErrorLogState,
            summary,
            Date.now(),
            POLLING_ERROR_DEDUPE_WINDOW_MS
          );
          if (decision.shouldLog) {
            const suffix = decision.suppressedCount > 0
              ? `（已省略 ${decision.suppressedCount} 次重複錯誤）`
              : "";
            logger.warn(`Polling 網路異常（重試中）：${summary}${suffix}`);
          }
        } else {
          logger.error("Polling error", err);
          if (summary) {
            logger.warn(`Polling 網路摘要：${summary}`);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private async clearOfflineUpdates(): Promise<void> {
    const maxRetries = 3;
    let attempt = 0;
    let updates: TelegramUpdate[];
    while (true) {
      try {
        updates = await this.api.getUpdates(undefined, 0, 100);
        break;
      } catch (err) {
        attempt++;
        if (attempt >= maxRetries) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`clearOfflineUpdates retry ${attempt}/${maxRetries}`, msg);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    while (updates.length > 0) {
      const last = updates[updates.length - 1];
      if (last) this.offset = last.update_id + 1;
      updates = await this.api.getUpdates(this.offset, 0, 100);
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    try {
      if (update.message) {
        await this.handleMessage(update.message);
      } else if (update.callback_query) {
        await this.handleCallback(update.callback_query);
      }
    } catch (err) {
      logger.error("handleUpdate error", err);
    }
  }

  private isOwner(chatId: number, userId?: number): boolean {
    if (!userId) return false;
    return String(chatId) === this.ownerChatId && String(userId) === this.ownerUserId;
  }

  private async classifyIntent(chatId: number, text: string, routerModel: string): Promise<"ROUTER" | "CORE"> {
    const providerType = this.resolveProviderForModel(routerModel);
    try {
      const client = await this.getIntentClassifierClient(providerType);
      
      const session = await client.createSession({
        model: routerModel,
        approvalMode: "plan",
        workingDirectory: APP_ROOT,
        systemPrompt: "You are an intent classifier. Determine if the user's request is simple (greetings, quick queries, simple docs, web search, casual chat) or complex (coding, reasoning, summarization, long writing, analysis, planning, structural decomposition). Never call tools. Return 'ROUTER' for simple and 'CORE' for complex. Return ONLY the label.",
        onPermissionRequest: async () => denyPermission(),
        hooks: {
          onPreToolUse: async (input: any) => {
            logger.warn("Classifier tool use denied", { tool: input?.toolName });
            return { permissionDecision: "deny" };
          }
        }
      });

      let classification = "CORE"; // Default to Core for safety
      session.onEvent((event) => {
        if (event.type === "assistant.message") {
          const content = (event.data as any)?.content;
          if (typeof content === "string") {
            const trimmed = content.trim().toUpperCase();
            if (trimmed.includes("ROUTER")) classification = "ROUTER";
            else if (trimmed.includes("CORE")) classification = "CORE";
          }
        }
      });

      await session.send(text);
      // Wait up to 30s for classification response to settle
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      
      await session.destroy();
      
      logger.info("Intent classified", { chatId, classification });
      return classification as "ROUTER" | "CORE";
    } catch (err) {
      await this.resetIntentClassifierClient();
      logger.warn("Classification failed, defaulting to CORE", err);
      return "CORE";
    }
  }

  private async getIntentClassifierClient(provider: ProviderType): Promise<AiClient> {
    if (this.intentClassifierClient && this.intentClassifierProvider === provider) {
      return this.intentClassifierClient;
    }

    await this.resetIntentClassifierClient();

    const client = this.createProviderClient(provider);
    try {
      await client.start();
    } catch (err) {
      await client.stop().catch(() => undefined);
      throw err;
    }

    this.intentClassifierClient = client;
    this.intentClassifierProvider = provider;
    return client;
  }

  private async resetIntentClassifierClient(): Promise<void> {
    if (!this.intentClassifierClient) {
      this.intentClassifierProvider = undefined;
      return;
    }

    const client = this.intentClassifierClient;
    this.intentClassifierClient = undefined;
    this.intentClassifierProvider = undefined;

    await client.stop().catch((err) => {
      if (!isConnectionDisposedError(err)) {
        logger.warn("Stop intent classifier client failed", err);
      }
    });
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    const hasText = Boolean(message.text || message.caption);
    if (!hasText && !message.photo && !message.document) return;
    const chatId = message.chat.id;
    const userId = message.from?.id;

    try {
    logger.info("Message received", { chatId, messageId: message.message_id });
    if (message.text?.startsWith("/")) {
      await this.handleCommand(message);
      return;
    }

    if (!this.isOwner(chatId, userId)) {
      await this.safeSend(chatId, "抱歉，只有擁有者可以使用此機器人。", message.message_id);
      return;
    }

    const state = this.getOrCreateState(chatId);
    state.pendingRecovery = undefined;
    state.lastProactiveRebuildNotice = undefined;

    if (message.photo || message.document) {
      const handled = await this.handleImages(message, state);
      const userText = message.text ?? message.caption;
      if (!userText || !userText.trim()) {
        if (handled) return;
      }
    }

    const userText = (message.text ?? message.caption ?? "").trim();
    if (!userText) return;

    const canBootstrapAutoSession = state.mode === "auto" && Boolean(state.workDir) && !state.session;
    if (!state.workDir || (!state.session && !canBootstrapAutoSession)) {
      await this.safeSend(chatId, "請先使用 /project 選擇專案。", message.message_id);
      return;
    }

    if (state.resetting) {
      await this.safeSend(chatId, "工作階段正在重設，請稍後再試。", message.message_id);
      return;
    }

    const policy = await this.guardrailsPromise;
    const promptLimit = policy.maxPromptLength ?? MESSAGE_LIMIT;
    const decision = evaluatePrompt(policy, userText);
    if (!decision.allowed) {
      await this.safeSend(
        chatId,
        `提示詞被拒絕：${decision.reason ?? "不符合安全規則"} (${decision.ruleId ?? decision.source})`,
        message.message_id
      );
      return;
    }

    const prompt = composePrompt(userText, state.attachments);
    // Skip semantic checks on composed prompt: user text was already checked
    // above, and base64 attachment data can cause false semantic_sensitive_request.
    const combinedDecision = evaluatePromptWithOptions(policy, prompt, { ignoreLength: true, skipSemantic: true });
    if (!combinedDecision.allowed) {
      await this.safeSend(
        chatId,
        `提示詞被拒絕：${combinedDecision.reason ?? "不符合安全規則"} (${combinedDecision.ruleId ?? combinedDecision.source})`,
        message.message_id
      );
      return;
    }

    if (state.processing) {
      if (state.pendingTasks.length >= PENDING_LIMIT) {
        await this.safeSend(chatId, "待辦已滿，請稍後再試。", message.message_id);
        return;
      }
      state.pendingTasks.push({ prompt, queuedAt: Date.now() });
      logger.info("Prompt queued", { chatId, size: state.pendingTasks.length });
      const queueNotice = `已加入待辦 (${state.pendingTasks.length}/${PENDING_LIMIT})`;
      if (state.silentMode) {
        await this.silentSend(chatId, queueNotice, message.message_id);
      } else {
        await this.safeSend(chatId, queueNotice, message.message_id);
      }
      return;
    }

    // Auto mode: classify intent and switch provider/model accordingly
    if (state.mode === "auto" && state.routerModel && state.coreModel) {
      const intent = await this.classifyIntent(chatId, userText, state.routerModel);
      const targetModel = intent === "ROUTER" ? state.routerModel : state.coreModel;
      const targetProvider = this.resolveProviderForModel(targetModel);
      
      if (!state.session || state.provider !== targetProvider || state.model !== targetModel) {
        logger.info("Auto routing", { intent, targetProvider, targetModel });
        if (state.provider !== targetProvider) {
          state.provider = targetProvider;
        }
        state.model = targetModel;
        if (state.workDir) {
          await this.createSession(chatId, state.workDir, targetModel);
        }
      }
    }

    const aiAttachments = this.toAiAttachments(state.attachments);
    const sendResult = await this.sendPreparedPrompt(state, prompt, message.message_id, promptLimit, aiAttachments);
    // Clear consumed attachments so they don't pollute subsequent messages
    if (state.attachments.length > 0) {
      state.attachments = [];
    }
    } catch (err) {
      logger.error("handleMessage error", err);
      await this.safeSend(chatId, "處理訊息時發生錯誤，請稍後再試。", message.message_id);
    }
  }

  private touchSession(state: AgentContext): void {
    if (!state.session) return;
    const now = Date.now();
    if (state.sessionCreatedAt === undefined) {
      state.sessionCreatedAt = now;
    }
    state.sessionLastActivityAt = now;
  }

  private clearProcessingTimer(state: AgentContext): void {
    if (!state.processingTimer) return;
    clearTimeout(state.processingTimer);
    state.processingTimer = undefined;
  }

  private preparePromptDispatch(state: AgentContext, prompt: string, replyTo?: number): void {
    state.processing = true;
    state.activePrompt = prompt;
    state.replyToMessageId = replyTo;
    state.promptCycles += 1;
    state.awaitingReply = true;
    state.completionPending = false;
    state.receivedAssistantMessage = false;
    state.lastAssistantMessageHash = undefined;
    state.lastAssistantMessageText = undefined;
    state.silentAnchorMessageId = undefined;
    this.touchSession(state);
  }

  private scheduleProcessingTimer(state: AgentContext): void {
    this.clearProcessingTimer(state);
    state.processingTimer = setTimeout(() => {
      const targetMessageId = state.silentMode
        ? (state.silentAnchorMessageId ?? state.processingMessageId)
        : state.processingMessageId;
      if (targetMessageId) {
        const modelEntry = state.model
          ? this.formatModelEntry(state.provider, state.model)
          : this.formatResolvedModelEntry(state.coreModel ?? state.routerModel);
        this.api
          .editMessageText({
            chat_id: state.chatId,
            message_id: targetMessageId,
            text: this.prepareOutgoingText(state.chatId, `⏳處理中…仍在等待 ${modelEntry} 回覆`),
            parse_mode: "MarkdownV2"
          })
          .catch((err) => logger.warn("Update processing message failed", err));
      }
    }, 20_000);
  }

  private buildRecoveryKeyboard(recoveryId: string): InlineKeyboardMarkup {
    return {
      inline_keyboard: [[
        { text: "✅ 仍要發送", callback_data: `recovery.resend:${recoveryId}` },
        { text: "❌ 取消", callback_data: `recovery.cancel:${recoveryId}` }
      ]]
    };
  }

  private async sendPreparedPrompt(
    state: AgentContext,
    prompt: string,
    replyTo: number | undefined,
    promptLimit?: number,
    aiAttachments?: AiAttachment[]
  ): Promise<SendPromptResult> {
    this.preparePromptDispatch(state, prompt, replyTo);
    await quotaService.increment(String(state.chatId), state.provider, state.model ?? "unknown");

    const processingText = `⏳處理中：${prompt.slice(0, 80)}`;
    const processing = state.silentMode
      ? await this.silentSend(state.chatId, processingText, replyTo)
      : await this.safeSend(state.chatId, processingText, replyTo);
    state.processingMessageId = processing?.message_id ?? (state.silentMode ? state.silentAnchorMessageId : undefined);
    this.scheduleProcessingTimer(state);

    logger.info("Prompt sending", { chatId: state.chatId });
    const sendResult = await this.sendPrompt(state, prompt, replyTo, promptLimit, aiAttachments);
    if (sendResult.chunked && sendResult.totalChunks > 1) {
      const chunkNotice = `提示詞過長，已拆分為 ${sendResult.totalChunks} 段送出以維持完整內容。`;
      if (state.silentMode) {
        await this.silentSend(state.chatId, chunkNotice, replyTo);
      } else {
        await this.safeSend(state.chatId, chunkNotice, replyTo);
      }
    }
    return sendResult;
  }

  private async handleDisconnectedSession(
    state: AgentContext,
    prompt: string,
    replyTo: number | undefined,
    aiAttachments?: AiAttachment[]
  ): Promise<boolean> {
    if (!state.workDir || !state.model) {
      return false;
    }

    const queuedTasks = [...state.pendingTasks];

    try {
      await this.createSession(state.chatId, state.workDir, state.model, { announce: false });
    } catch (err) {
      logger.warn("Session rebuild failed after disconnect", err);
      return false;
    }
    if (!state.session) {
      return false;
    }

    state.pendingTasks = queuedTasks;
    const recovery = {
      id: crypto.randomUUID(),
      prompt,
      createdAt: Date.now(),
      ...(replyTo !== undefined ? { replyToMessageId: replyTo } : {}),
      ...(aiAttachments !== undefined ? { aiAttachments } : {})
    };
    state.pendingRecovery = recovery;
    state.processing = false;
    state.activePrompt = undefined;
    state.awaitingReply = false;
    state.completionPending = false;
    state.receivedAssistantMessage = false;
    state.lastAssistantMessageHash = undefined;
    state.lastAssistantMessageText = undefined;
    this.clearProcessingTimer(state);

    if (state.processingMessageId) {
      await this.editMessageSafe(state.chatId, state.processingMessageId, "♻️ 偵測到工作階段已中斷，正在改用新工作階段。");
      state.processingMessageId = undefined;
    }

    await this.safeSend(
      state.chatId,
      "♻️ 偵測到工作階段已中斷，已重建工作階段。\n\n是否仍要發送原訊息？",
      replyTo,
      this.buildRecoveryKeyboard(recovery.id)
    );
    return true;
  }

  private async handleRecoveryAction(
    chatId: number,
    recoveryId: string,
    shouldResend: boolean,
    replyTo?: number
  ): Promise<void> {
    const state = this.getOrCreateState(chatId);
    const pending = state.pendingRecovery;
    if (!pending || pending.id !== recoveryId) {
      await this.safeSend(chatId, "這個重送請求已過期。", replyTo);
      return;
    }

    state.pendingRecovery = undefined;

    if (!shouldResend) {
      await this.safeSend(chatId, "已取消重送原訊息。", replyTo);
      return;
    }

    const policy = await this.guardrailsPromise;
    const promptLimit = policy.maxPromptLength ?? MESSAGE_LIMIT;
    await this.sendPreparedPrompt(
      state,
      pending.prompt,
      pending.replyToMessageId,
      promptLimit,
      pending.aiAttachments
    );
  }

  private async checkSessionHealth(): Promise<void> {
    const now = Date.now();

    for (const [chatId, state] of this.states) {
      if (!state.session || !state.workDir || !state.model) continue;
      if (state.processing || state.resetting || state.pendingRecovery) continue;

      const createdAt = state.sessionCreatedAt ?? now;
      const lastActivityAt = state.sessionLastActivityAt ?? createdAt;
      const lifetimeExceeded = now - createdAt >= SESSION_MAX_LIFETIME_MS;
      const idleExceeded = now - lastActivityAt >= SESSION_IDLE_REBUILD_MS;

      if (!lifetimeExceeded && !idleExceeded) continue;

      const reason = lifetimeExceeded ? "工作階段已達使用上限" : "工作階段閒置過久";
      logger.info("Proactive session rebuild", {
        chatId,
        reason: lifetimeExceeded ? "lifetime" : "idle"
      });

      await this.createSession(chatId, state.workDir, state.model, { announce: false });
      if (!state.session) {
        continue;
      }

      if (!isQuietHours(now)) {
        const existing = state.lastProactiveRebuildNotice;
        if (existing) {
          const nextCount = existing.count + 1;
          await this.editMessageSafe(
            chatId,
            existing.messageId,
            `♻️ ${reason}，已自動重建工作階段。下一則訊息可直接繼續。(${nextCount})`
          );
          state.lastProactiveRebuildNotice = { messageId: existing.messageId, count: nextCount };
        } else {
          const sent = await this.safeSend(
            chatId,
            `♻️ ${reason}，已自動重建工作階段。下一則訊息可直接繼續。(1)`
          );
          if (sent) {
            state.lastProactiveRebuildNotice = { messageId: sent.message_id, count: 1 };
          }
        }
      } else {
        logger.info("Proactive rebuild notification suppressed (quiet hours)", { chatId });
      }
    }
  }

  private async handleImages(message: TelegramMessage, state: AgentContext): Promise<boolean> {
    const chatId = message.chat.id;

    if (state.attachments.length >= MAX_ATTACHMENTS) {
      await this.safeSend(chatId, "圖片已達上限 (8 張)。", message.message_id);
      return false;
    }

    const fileId = message.photo?.[message.photo.length - 1]?.file_id ?? message.document?.file_id;
    if (!fileId) return false;

    const fileInfo = await this.api.getFile(fileId);
    if (!fileInfo.file_path) {
      await this.safeSend(chatId, "無法取得圖片路徑。", message.message_id);
      return false;
    }

    if (fileInfo.file_size && fileInfo.file_size > MAX_ATTACHMENT_BYTES) {
      await this.safeSend(chatId, "圖片大小超過限制 (8MB)。", message.message_id);
      return false;
    }

    const buffer = await this.api.downloadFile(fileInfo.file_path, MAX_ATTACHMENT_BYTES);
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      await this.safeSend(chatId, "圖片大小超過限制 (8MB)。", message.message_id);
      return false;
    }

    const isPhoto = Boolean(message.photo);
    const documentMime = message.document?.mime_type;
    if (!isPhoto && documentMime && !documentMime.startsWith("image/")) {
      await this.safeSend(chatId, "檔案不是圖片格式。", message.message_id);
      return false;
    }

    let output = buffer;
    let mime = documentMime ?? "image/jpeg";
    if (isPhoto) {
      try {
        output = await reencodePhoto(buffer);
      } catch (err) {
        logger.warn("Photo re-encode failed", err);
        await this.safeSend(chatId, "圖片轉檔失敗，請稍後再試。", message.message_id);
        return false;
      }
      if (output.length > MAX_ATTACHMENT_BYTES) {
        await this.safeSend(chatId, "圖片大小超過限制 (8MB)。", message.message_id);
        return false;
      }
      mime = "image/jpeg";
    }

    const dataUrl = `data:${mime};base64,${output.toString("base64")}`;

    // Save attachment to disk so AI tools can access the file
    let filePath: string | undefined;
    if (state.workDir) {
      try {
        const attachDir = path.join(state.workDir, "attachments");
        await fs.mkdir(attachDir, { recursive: true });
        const ext = MIME_EXTENSIONS[mime] ?? mime.split("/")[1] ?? "bin";
        const fileName = `photo_${Date.now()}_${state.attachments.length}.${ext}`;
        filePath = path.join(attachDir, fileName);
        await fs.writeFile(filePath, output);
      } catch (err) {
        logger.warn("Failed to save attachment to disk", err);
        // Continue without filePath — the dataUrl fallback is still available
      }
    }

    const attachment: import("./session/state.js").Attachment = { dataUrl, mime, addedAt: Date.now() };
    if (filePath) attachment.filePath = filePath;
    state.attachments.push(attachment);
    await this.safeSend(chatId, `已附加圖片 (${state.attachments.length}/${MAX_ATTACHMENTS})`, message.message_id);
    return true;
  }

  private extractPromptLengthLimit(error: unknown): number | undefined {
    const message = String((error as { message?: string })?.message ?? error ?? "");
    const match =
      message.match(/上限[^\d]*(\d{3,6})/i) ||
      message.match(/limit[^\d]*(\d{3,6})/i) ||
      message.match(/max[^\d]*(\d{3,6})/i) ||
      message.match(/\((\d{3,6})\)/);
    if (!match?.[1]) return undefined;
    const value = Number(match[1]);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }

  private isPromptLengthError(error: unknown): boolean {
    const message = String((error as { message?: string })?.message ?? error ?? "");
    return /length|token|上限|limit|max/i.test(message);
  }

  private toAiAttachments(attachments: Attachment[]): AiAttachment[] {
    return attachments
      .filter((a) => a.filePath)
      .map((a) => ({ type: a.mime, path: a.filePath!, displayName: path.basename(a.filePath!) }));
  }

  private async trySendPromptInChunks(
    state: AgentContext,
    prompt: string,
    promptLimit?: number,
    aiAttachments?: AiAttachment[]
  ): Promise<number> {
    const limit = promptLimit;
    if (!limit || prompt.length <= limit) return 0;
    const chunks = buildPromptChunks(prompt, limit);
    if (chunks.total <= 1) return 0;
    logger.info("AI send chunked", { chatId: state.chatId, total: chunks.total });
    for (let i = 0; i < chunks.chunks.length; i++) {
      const chunk = chunks.chunks[i]!;
      // Pass attachments only with the first chunk
      if (i === 0 && aiAttachments?.length) {
        await state.session?.send(chunk, aiAttachments);
      } else {
        await state.session?.send(chunk);
      }
    }
    return chunks.total;
  }

  private async sendPrompt(
    state: AgentContext,
    prompt: string,
    replyTo?: number,
    promptLimit?: number,
    aiAttachments?: AiAttachment[]
  ): Promise<SendPromptResult> {
    if (!state.session) return { chunked: false, totalChunks: 0 };
    try {
      logger.info("AI send", { chatId: state.chatId });
      await state.session.send(prompt, aiAttachments);
      logger.info("AI send ok", { chatId: state.chatId });
      return { chunked: false, totalChunks: 1 };
    } catch (err) {
      const isLength = this.isPromptLengthError(err);
      const limit = this.extractPromptLengthLimit(err) ?? promptLimit;
      if (isLength && limit) {
        try {
          const total = await this.trySendPromptInChunks(state, prompt, limit, aiAttachments);
          if (total > 0) {
            return { chunked: true, totalChunks: total };
          }
        } catch (chunkErr) {
          logger.warn("Chunked prompt send failed", chunkErr);
        }
      }

      if (isConnectionDisposedError(err)) {
        const recovered = await this.handleDisconnectedSession(state, prompt, replyTo, aiAttachments);
        if (recovered) {
          return { chunked: false, totalChunks: 0, recovered: true };
        }
      }

      state.processing = false;
      state.awaitingReply = false;
      state.activePrompt = undefined;
      this.clearProcessingTimer(state);
      if (state.processingMessageId) {
        await this.api.editMessageText({
          chat_id: state.chatId,
          message_id: state.processingMessageId,
          text: this.prepareOutgoingText(state.chatId, `❌失敗：${String(err)}`),
          parse_mode: "MarkdownV2"
        });
        state.processingMessageId = undefined;
      }
      logger.error("Send prompt failed", err);
      await this.safeSend(state.chatId, `送出提示詞失敗：${String(err)}`, replyTo);
      return { chunked: false, totalChunks: 0 };
    }
  }

  private async handleCommand(message: TelegramMessage): Promise<void> {
    const chatId = message.chat.id;
    const userId = message.from?.id;
    const text = message.text ?? "";
    const [command, ...args] = text.trim().split(/\s+/);

    if (!this.isOwner(chatId, userId)) {
      await this.safeSend(chatId, "抱歉，只有擁有者可以使用此機器人。", message.message_id);
      return;
    }

    switch (command) {
      case "/help":
        await this.sendWelcome(undefined, await this.loadAllowedDirectories(), await this.getModels(this.getOrCreateState(chatId).provider), message);
        return;
      case "/project":
        await this.sendDirectoryList(chatId);
        return;
      case "/newproject":
        await this.handleNewProject(chatId, args.join(" "));
        return;
      case "/model":
        await this.handleModelCommand(chatId, args[0]);
        return;
      case "/info":
      case "/i":
        await this.sendStatus(chatId);
        return;
      case "/clear":
        await this.handleClear(chatId);
        return;
      case "/router": {
        const prompt = args.join(" ").trim();
        await this.handleRouterCommand(chatId, prompt);
        return;
      }
      case "/allowall":
        await this.handleAllowAllToggle(chatId);
        return;
      case "/silent":
        await this.handleSilentToggle(chatId);
        return;
      case "/restart":
        if (message.date < this.startTimestamp) return;
        await this.handleRestart(chatId);
        return;
      case "/quit":
        if (message.date < this.startTimestamp) return;
        await this.shutdown();
        return;
      default:
        await this.safeSend(chatId, `未知指令：${command}`, message.message_id);
        return;
    }
  }

  private async handleCallback(callback: TelegramCallbackQuery): Promise<void> {
    const message = callback.message;
    if (message?.date && message.date < this.startTimestamp) return;

    const chatId = message?.chat.id;
    if (!chatId) return;

    try {
    if (!this.isOwner(chatId, callback.from.id)) {
      await this.api.answerCallbackQuery(callback.id);
      await this.safeSend(chatId, "抱歉，只有擁有者可以使用此機器人。", message?.message_id);
      return;
    }

    await this.api.answerCallbackQuery(callback.id);
    const data = callback.data ?? "";

    if (data === "restart.confirm") {
      if (this.restartConfirmTimer) clearTimeout(this.restartConfirmTimer);
      this.restartConfirmTimer = undefined;
      clearRestartState();
      if (message) {
        await this.editMessageSafe(chatId, message.message_id, "✅ 服務確認正常，熱啟動完成。");
      }
      return;
    }
    if (data === "restart.deny") {
      if (this.restartConfirmTimer) clearTimeout(this.restartConfirmTimer);
      this.restartConfirmTimer = undefined;
      await this.handleRestartRollback(chatId);
      return;
    }

    if (data === "do.project") {
      await this.sendDirectoryList(chatId);
      return;
    }
    if (data === "do.model") {
      await this.handleModelCommand(chatId, undefined);
      return;
    }
    if (data.startsWith("do.model:")) {
      const arg = data.slice(9);
      await this.handleModelCommand(chatId, arg);
      return;
    }
    if (data === "do.info") {
      await this.sendStatus(chatId);
      return;
    }
    if (data.startsWith("do.shortcut:")) {
      const shortcutKey = data.slice(12);
      await this.handleShortcut(chatId, shortcutKey);
      return;
    }
    if (data === "do.help") {
      await this.sendWelcome(undefined, await this.loadAllowedDirectories(), await this.getModels(this.getOrCreateState(chatId!).provider));
      return;
    }

    if (data.startsWith("pick.proj:")) {
      const index = Number.parseInt(data.split(":")[1] ?? "", 10);
      await this.setDirectory(chatId, index);
      return;
    }
    if (data.startsWith("pick.mod:")) {
      const index = Number.parseInt(data.split(":")[1] ?? "", 10);
      await this.setModel(chatId, index);
      return;
    }
    if (data.startsWith("peek.arg:")) {
      const key = data.slice(9);
      await this.showStoredText(chatId, key, "參數", message?.message_id);
      return;
    }
    if (data.startsWith("peek.res:")) {
      const key = data.slice(9);
      await this.showStoredText(chatId, key, "結果", message?.message_id, true);
      return;
    }
    if (data.startsWith("recovery.resend:")) {
      await this.handleRecoveryAction(chatId, data.slice(16), true, message?.message_id);
      return;
    }
    if (data.startsWith("recovery.cancel:")) {
      await this.handleRecoveryAction(chatId, data.slice(16), false, message?.message_id);
      return;
    }
    if (data.startsWith("tool.confirm:")) {
      const confirmId = data.slice(13);
      const pending = this.pendingToolConfirmations.get(confirmId);
      if (pending) {
        this.pendingToolConfirmations.delete(confirmId);
        pending.resolve(true);
        const confirmState = this.states.get(chatId);
        if (confirmState?.silentMode && confirmState.silentAnchorMessageId) {
          await this.editMessageSafe(chatId, confirmState.silentAnchorMessageId, "✅ 已允許執行。");
        } else {
          await this.safeSend(chatId, "✅ 已允許執行。", message?.message_id);
        }
      }
      return;
    }
    if (data.startsWith("tool.deny:")) {
      const confirmId = data.slice(10);
      const pending = this.pendingToolConfirmations.get(confirmId);
      if (pending) {
        this.pendingToolConfirmations.delete(confirmId);
        pending.resolve(false);
        const denyState = this.states.get(chatId);
        if (denyState?.silentMode && denyState.silentAnchorMessageId) {
          await this.editMessageSafe(chatId, denyState.silentAnchorMessageId, "❌ 已拒絕執行。");
        } else {
          await this.safeSend(chatId, "❌ 已拒絕執行。", message?.message_id);
        }
      }
      return;
    }
    } catch (err) {
      logger.error("handleCallback error", err);
      await this.safeSend(chatId, "處理按鈕時發生錯誤，請稍後再試。", message?.message_id);
    }
  }

  private async showStoredText(chatId: number, key: string | undefined, label: string, replyTo?: number, isResult = false): Promise<void> {
    if (!key) return;
    const store = isResult ? this.toolResults : this.toolParams;
    const text = store.get(key);
    if (!text) {
      await this.safeSend(chatId, `${label}已過期或不存在。`, replyTo);
      return;
    }
    await this.safeSend(chatId, `${label}\n\n${text}`, replyTo);
  }

  private async handleAllowAllToggle(chatId: number): Promise<void> {
    const state = this.getOrCreateState(chatId);
    state.allowAll = !state.allowAll;
    const statusText = state.allowAll
      ? "🔓 已切換為「全部允許」模式，工具操作將自動批准，不再逐次詢問。\n再次輸入 /allowall 可回到確認模式。"
      : "🔒 已切換回「操作確認」模式，高風險操作將逐次詢問。";
    await this.safeSend(chatId, statusText);
  }

  private async handleSilentToggle(chatId: number): Promise<void> {
    const state = this.getOrCreateState(chatId);
    state.silentMode = !state.silentMode;
    if (!state.silentMode) {
      state.silentAnchorMessageId = undefined;
    }
    const statusText = state.silentMode
      ? "🔇 已開啟安靜模式，中間訊息將整合顯示，減少通知。\n再次輸入 /silent 可關閉。"
      : "🔔 已關閉安靜模式，訊息將正常發送。";
    await this.safeSend(chatId, statusText);
  }

  private async requestInteractiveApproval(chatId: number, label: string, preview: string): Promise<boolean> {
    const state = this.states.get(chatId);
    if (state?.allowAll) return true;

    const confirmId = crypto.randomUUID();
    const text = `🔧 工具 *${label}* 需要確認：\n\`${preview}\``;
    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [[
        { text: "✅ 允許", callback_data: `tool.confirm:${confirmId}` },
        { text: "❌ 拒絕", callback_data: `tool.deny:${confirmId}` }
      ]]
    };
    if (state?.silentMode && state.silentAnchorMessageId) {
      await this.editMessageSafe(chatId, state.silentAnchorMessageId, text, keyboard);
    } else {
      await this.safeSend(chatId, text, undefined, keyboard);
    }

    return new Promise<boolean>((resolve) => {
      this.pendingToolConfirmations.set(confirmId, { resolve });
      setTimeout(() => {
        if (this.pendingToolConfirmations.has(confirmId)) {
          this.pendingToolConfirmations.delete(confirmId);
          resolve(false);
        }
      }, TOOL_CONFIRM_TIMEOUT_MS);
    });
  }

  private createPermissionRequestHandler(chatId: number, workspaceDir: string): AiPermissionHandler {
    return async (request: AiPermissionRequest): Promise<AiPermissionResult> => {
      switch (request.kind) {
        case "read": {
          const restriction = await getPathRestriction(request.path, workspaceDir);
          if (restriction) {
            logger.warn("Permission denied by policy", { kind: request.kind, path: request.path, reason: restriction });
            return denyPermission();
          }
          return approvePermission();
        }
        case "write": {
          const allowed = await this.requestInteractiveApproval(
            chatId,
            request.kind,
            JSON.stringify({ fileName: request.fileName, intention: request.intention }).slice(0, TOOL_PREVIEW_LEN)
          );
          return allowed ? approvePermission() : { kind: "denied-interactively-by-user" };
        }
        case "shell": {
          const allowed = await this.requestInteractiveApproval(
            chatId,
            request.kind,
            request.fullCommandText.slice(0, TOOL_PREVIEW_LEN)
          );
          return allowed ? approvePermission() : { kind: "denied-interactively-by-user" };
        }
        case "mcp": {
          if (request.readOnly) return approvePermission();
          const allowed = await this.requestInteractiveApproval(
            chatId,
            `${request.kind}:${request.serverName}/${request.toolName}`,
            JSON.stringify(request.args ?? {}).slice(0, TOOL_PREVIEW_LEN)
          );
          return allowed ? approvePermission() : { kind: "denied-interactively-by-user" };
        }
        case "url":
        case "memory":
          return approvePermission();
        case "custom-tool":
          logger.warn("Permission denied without approval rule", { kind: request.kind, tool: request.toolName });
          return denyPermission();
      }
    };
  }

  private async setProvider(chatId: number, provider: ProviderType): Promise<void> {
    const state = this.getOrCreateState(chatId);
    const oldProvider = state.provider;
    state.provider = provider;

    if (oldProvider !== provider && state.session) {
      try { await state.session.destroy(); } catch { /* ignore */ }
      try { await state.client?.stop(); } catch { /* ignore */ }
      state.session = undefined;
      state.client = undefined;
    }

    state.model = undefined;
    const models = await this.getModels(provider);
    const defaultModel = getDefaultModel(models);
    if (defaultModel) state.model = defaultModel;

    if (state.workDir && state.model) {
      await this.createSession(chatId, state.workDir, state.model);
    }
  }

  private async handleModelCommand(chatId: number, arg?: string): Promise<void> {
    const state = this.getOrCreateState(chatId);
    
    // If no arg, show unified selection list
    if (!arg) {
      await this.sendUnifiedModelList(chatId);
      return;
    }

    if (arg === "auto") {
      state.mode = "auto";
      await this.safeSend(
        chatId,
        `✅ 已切換為自動模式 (Auto Mode)\nRouter: ${this.formatResolvedModelEntry(state.routerModel)}\nCore: ${this.formatResolvedModelEntry(state.coreModel)}`,
        undefined
      );
      await this.sendStatusFooter(chatId);
      return;
    }

    if (arg === "config_router") {
      await this.sendRouterModelList(chatId);
      return;
    }

    if (arg === "config_core") {
      await this.sendCoreModelList(chatId);
      return;
    }

    if (arg.startsWith("pick.manual:")) {
      const index = parseInt(arg.split(":")[1] || "0", 10);
      const allModels = getAllModels();
      const selected = allModels[index];
      if (selected) {
        state.mode = "manual";
        // Switch provider if needed
        if (state.provider !== selected.provider) {
           await this.setProvider(chatId, selected.provider);
        }
        // Set model
        await this.applyModelChange(chatId, selected.model);
      }
      return;
    }

    // Handle "pick.router:idx" format
    if (arg.startsWith("pick.router:")) {
      const index = parseInt(arg.split(":")[1] || "0", 10);
      const allModels = getAllModels();
      const selected = allModels[index];
      
      if (selected) {
        state.routerModel = selected.model;
        await this.safeSend(chatId, `Router 模型已設定為：${selected.entry}`, undefined);
        // Return to main menu instead of chaining
        await this.sendUnifiedModelList(chatId);
      }
      return;
    }

    // Handle "pick.core:idx" format
    if (arg.startsWith("pick.core:")) {
      const index = parseInt(arg.split(":")[1] || "0", 10);
      const allModels = getAllModels();
      const selected = allModels[index];

      if (selected) {
        state.coreModel = selected.model;
        await this.safeSend(chatId, `Core 模型已設定為：${selected.entry}`, undefined);
        await this.sendUnifiedModelList(chatId);
      }
      return;
    }

    // Legacy fallback
    const models = await this.getModels(state.provider);
    const index = parseIndex(arg, models.length);
    if (index < 0 || index >= models.length) {
      await this.safeSend(chatId, "模型編號無效。", undefined);
      return;
    }
    const selected = models[index];
    if (!selected) return;
    await this.applyModelChange(chatId, selected);
  }

  private async sendUnifiedModelList(chatId: number): Promise<void> {
    const state = this.getOrCreateState(chatId);
    const keyboard: InlineKeyboardMarkup = { inline_keyboard: [] };

    // Auto Mode Section
    const autoLabel = state.mode === "auto" ? "✅ 自動模式 (已啟用)" : "⚪ 啟用自動模式";
    keyboard.inline_keyboard.push([{ text: autoLabel, callback_data: "do.model:auto" }]);
    
    // Config Section (always visible or only when auto? User asked to simplify, let's keep it visible for quick access)
    keyboard.inline_keyboard.push([
      { text: `⚙️ Router: ${this.formatResolvedModelEntry(state.routerModel)}`, callback_data: "do.model:config_router" },
      { text: `⚙️ Core: ${this.formatResolvedModelEntry(state.coreModel)}`, callback_data: "do.model:config_core" }
    ]);

    // Manual Models Section
    const allModels = getAllModels();
    allModels.forEach((m, index) => {
      if (index % 1 === 0) keyboard.inline_keyboard.push([]);
      const row = keyboard.inline_keyboard[keyboard.inline_keyboard.length - 1]!;
      // Highlight if active AND in manual mode
      const isActive = state.mode === "manual" && state.model === m.model && state.provider === m.provider;
      const label = isActive ? `🟢 ${m.entry}` : m.entry;
      row.push({ text: label, callback_data: `do.model:pick.manual:${index}` });
    });

    await this.safeSend(chatId, "請選擇模型模式：", undefined, keyboard);
  }

  private async sendRouterModelList(chatId: number): Promise<void> {
    const allModels = getAllModels();
    const candidates = allModels.filter((m) => isRouterCandidateModel(m.model));
    
    const keyboard: InlineKeyboardMarkup = { inline_keyboard: [] };
    const state = this.getOrCreateState(chatId);
    
    candidates.forEach((m, index) => {
      const globalIndex = allModels.indexOf(m);
      if (index % 1 === 0) keyboard.inline_keyboard.push([]);
      const row = keyboard.inline_keyboard[keyboard.inline_keyboard.length - 1]!;
      const label = m.model === state.routerModel ? `🟢 ${m.entry}` : m.entry;
      row.push({ text: label, callback_data: `do.model:pick.router:${globalIndex}` });
    });
    
    await this.safeSend(chatId, "請選擇 **Router 模型** (一般查詢、意圖判斷)：", undefined, keyboard);
  }

  private async sendCoreModelList(chatId: number): Promise<void> {
    const allModels = getAllModels();
    const candidates = allModels.filter((m) => !isRouterCandidateModel(m.model));

    const keyboard: InlineKeyboardMarkup = { inline_keyboard: [] };
    const state = this.getOrCreateState(chatId);

    candidates.forEach((m, index) => {
      const globalIndex = allModels.indexOf(m);
      if (index % 1 === 0) keyboard.inline_keyboard.push([]);
      const row = keyboard.inline_keyboard[keyboard.inline_keyboard.length - 1]!;
      const label = m.model === state.coreModel ? `🟢 ${m.entry}` : m.entry;
      row.push({ text: label, callback_data: `do.model:pick.core:${globalIndex}` });
    });

    await this.safeSend(chatId, "請選擇 **Core 模型** (深度問答、代碼、寫作)：", undefined, keyboard);
  }

  private async handleShortcut(chatId: number, shortcutKey: string): Promise<void> {
    const config = SHORTCUT_BUTTONS.find((sc) => sc.callbackKey === shortcutKey);
    if (!config) {
      await this.safeSend(chatId, "未知的快捷操作。");
      return;
    }

    const dirs = await this.loadAllowedDirectories();
    const targetDir = dirs.find((d) => path.basename(d) === config.targetDirName);
    if (!targetDir) {
      await this.safeSend(
        chatId,
        `找不到「${config.targetDirName}」專案，請先透過 /newproject 建立或確認目錄設定。`
      );
      return;
    }

    const state = this.getOrCreateState(chatId);
    const parsed = parseConfiguredModelEntry(config.modelEntry);
    state.provider = parsed.provider;
    state.model = parsed.model;
    state.mode = "manual";

    await this.createSession(chatId, targetDir, parsed.model);
    await this.sendStatusFooter(chatId);
  }

  private async sendDirectoryList(chatId: number): Promise<void> {
    const dirs = await this.loadAllowedDirectories();
    if (!dirs.length) {
      await this.safeSend(chatId, "沒有可用的專案。", undefined);
      return;
    }

    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: []
    };

    dirs.forEach((dir, index) => {
      if (index % 2 === 0) keyboard.inline_keyboard.push([]);
      const row = keyboard.inline_keyboard[keyboard.inline_keyboard.length - 1]!;
      row.push({ text: path.basename(dir), callback_data: `pick.proj:${index}` });
    });

    const state = this.getOrCreateState(chatId);
    state.cachedDirs = dirs;

    await this.safeSend(chatId, "請選擇專案：", undefined, keyboard);
  }

  private async sendModelList(chatId: number, models: string[], current?: string): Promise<void> {
    const keyboard: InlineKeyboardMarkup = { inline_keyboard: [] };
    models.forEach((model, index) => {
      if (index % 2 === 0) keyboard.inline_keyboard.push([]);
      const row = keyboard.inline_keyboard[keyboard.inline_keyboard.length - 1]!;
      const label = model === current ? `🟢 ${model}` : model;
      row.push({ text: label, callback_data: `pick.mod:${index}` });
    });

    await this.safeSend(chatId, "請選擇模型：", undefined, keyboard);
  }

  private async setDirectory(chatId: number, index: number): Promise<void> {
    const state = this.getOrCreateState(chatId);
    const dirs = state.cachedDirs.length ? state.cachedDirs : await this.loadAllowedDirectories();
    if (!dirs[index]) {
      await this.safeSend(chatId, "專案索引無效。", undefined);
      return;
    }

    const selected = dirs[index];
    if (!selected) {
      await this.safeSend(chatId, "專案索引無效。", undefined);
      return;
    }
    if (state.mode === "auto" && !state.model) {
      state.workDir = selected;
      const projectLabel = path.basename(selected);
      await this.safeSend(
        chatId,
        `💎TeleTopaz in ${projectLabel} / 系統訊息\n\n📂 ${projectLabel}\n⚙️ ${this.formatStateModelLabel(state)}\n🔌 待路由`,
        undefined,
        this.buildNavKeyboard()
      );
      await this.sendStatusFooter(chatId);
      return;
    }
    await this.createSession(chatId, selected);
  }

  private async setModel(chatId: number, index: number): Promise<void> {
    const state = this.getOrCreateState(chatId);
    const models = await this.getModels(state.provider);
    if (!models[index]) {
      await this.safeSend(chatId, "模型索引無效。", undefined);
      return;
    }

    const selected = models[index];
    if (!selected) {
      await this.safeSend(chatId, "模型索引無效。", undefined);
      return;
    }
    await this.applyModelChange(chatId, selected);
  }

  private async applyModelChange(chatId: number, model: string): Promise<void> {
    const state = this.getOrCreateState(chatId);
    if (state.model && state.model !== model) {
      state.starredModels = [state.model, ...state.starredModels.filter((m) => m !== state.model)].slice(0, 2);
    }
    state.model = model;

    if (state.workDir) {
      await this.createSession(chatId, state.workDir, model);
    } else {
      await this.safeSend(chatId, "尚未選擇專案，請先選擇：", undefined);
      await this.sendDirectoryList(chatId);
    }
  }

  private async sendStatus(chatId: number): Promise<void> {
    const state = this.getOrCreateState(chatId);
    const ownerName = await this.fetchOwnerName();
    const stats = await quotaService.checkQuota(String(chatId));
    const usage = `${stats.stats.daily}/${stats.stats.monthly}`;

    const modelLabel = this.formatStateModelLabel(state);
    const projectLabel = state.workDir ? path.basename(state.workDir) : "未選擇";

    const lines = [
      `💎TeleTopaz in ${projectLabel} / 系統訊息`,
      "",
      `👤 ${ownerName}`,
      `⚙️ ${modelLabel}`,
      `📂 ${projectLabel}`,
      `📊 使用量：${usage} (今日/本月)`,
      `🔐 操作確認：${state.allowAll ? "全部允許" : "逐次確認"}`,
      `🔇 安靜模式：${state.silentMode ? "開啟" : "關閉"}`
    ];

    if (stats.stats.byModel && Object.keys(stats.stats.byModel).length > 0) {
      lines.push("📈 模型統計 (本月):");
      for (const [m, c] of Object.entries(stats.stats.byModel)) {
        lines.push(`  • ${this.formatStoredModelKey(m)}: ${c}`);
      }
    }

    lines.push(
      "",
      "📌 指令：","",
      "/project — 選擇專案","",
      "/newproject — 建立新專案（例：/newproject MyApp）","",
      "/model — 切換 AI 模型 (Auto/Manual)","",
      "/info — 說明","",
      "/clear — 清除對話與附件","",
      "/router {prompt} — 使用 routerModel 執行單次對話，完成後自動還原","",
      "/allowall — 切換全部允許/操作確認模式","",
      "/silent — 切換安靜/正常通知模式","",
      "/restart — 熱啟動","",
      "/quit — 關閉Bot","",
      "/help — 顯示說明與指令列表"
    );

    const keyboard = this.buildNavKeyboard();

    await this.safeSend(chatId, lines.join("\n"), undefined, keyboard);
  }

  /** /newproject — create a new project directory under the current workspace. */
  private async handleNewProject(chatId: number, name: string): Promise<void> {
    const state = this.getOrCreateState(chatId);

    if (!state.workDir) {
      await this.safeSend(chatId, "請先使用 /project 選擇專案。", undefined);
      return;
    }

    const trimmedName = name.trim();
    if (!trimmedName) {
      await this.safeSend(chatId, "❌ 請提供專案名稱（例：/newproject MyApp）。", undefined);
      return;
    }

    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(trimmedName)) {
      await this.safeSend(chatId, "❌ 專案名稱僅允許英數字、底線與連字號（1–64 字元）。", undefined);
      return;
    }

    const workspaceDir = path.dirname(state.workDir);
    const targetPath = path.join(workspaceDir, trimmedName);

    try {
      const exists = await fs.stat(targetPath).then(() => true).catch(() => false);
      if (exists) {
        await this.safeSend(chatId, `❌ 專案 ${trimmedName} 已存在。`, undefined);
        return;
      }

      await fs.mkdir(targetPath, { recursive: true });

      const workspaceLabel = path.basename(workspaceDir);
      await this.safeSend(chatId, `✅ 專案 ${trimmedName} 已建立於工作區 ${workspaceLabel}。`, undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.safeSend(chatId, `❌ 建立專案失敗：${msg}`, undefined);
    }
  }

  /** /clear — clear attachments + restart conversation, keeping project & model. */
  private async handleClear(chatId: number): Promise<void> {
    const state = this.getOrCreateState(chatId);
    // Clear attachments
    state.attachments = [];
    state.pendingTasks = [];
    state.silentAnchorMessageId = undefined;

    if (!state.workDir || !state.model) {
      await this.safeSend(chatId, "尚未建立工作階段。", undefined);
      await this.sendStatusFooter(chatId);
      return;
    }

    state.resetting = true;
    if (state.session) {
      try { await state.session.abort(); } catch (err) {
        if (!isConnectionDisposedError(err)) logger.warn("Abort session failed", err);
      }
    }

    await this.createSession(chatId, state.workDir, state.model);
    state.resetting = false;
    state.promptCycles = 0;
  }

  /** /router {prompt} — 使用 routerModel 執行單次對話，完成後自動還原所有狀態。 */
  private async handleRouterCommand(chatId: number, prompt: string): Promise<void> {
    const state = this.getOrCreateState(chatId);

    if (!prompt) {
      await this.safeSend(chatId, "⚠️ 請提供提示詞，例如：`/router 你好`");
      return;
    }

    if (state.processing) {
      await this.safeSend(chatId, "⚠️ 目前有其他對話正在處理中，請稍後再試。");
      return;
    }

    if (!state.workDir) {
      await this.safeSend(chatId, "⚠️ 請先選擇專案目錄（/project）");
      return;
    }

    const routerModelEntry = state.routerModel ?? DEFAULT_ROUTER_MODEL;
    const parsed = parseConfiguredModelEntry(routerModelEntry);
    const routerEntry = formatConfiguredModelEntry(parsed.provider, parsed.model);

    const snapshot: RouterSnapshot = {
      provider: state.provider,
      model: state.model,
      mode: state.mode,
      client: state.client,
      session: state.session,
    };

    await this.safeSend(chatId, `🔀 使用 \`${routerEntry}\` 執行單次對話...`);

    let tempClient: AiClient | undefined;

    const restoreSnapshot = async (tempSession: AiSession) => {
      try { await tempSession.destroy(); } catch {}
      if (tempClient && tempClient !== snapshot.client) {
        try { await tempClient.stop(); } catch {}
      }
      state.provider = snapshot.provider;
      state.model = snapshot.model;
      state.mode = snapshot.mode;
      state.client = snapshot.client;
      state.session = snapshot.session;
      if (snapshot.session) {
        state.sessionVersion += 1;
        const restoredVersion = state.sessionVersion;
        snapshot.session.onEvent((event) => {
          if (state.sessionVersion !== restoredVersion) return;
          void this.enqueueEvent(chatId, event);
        });
      }
      const restoredEntry = snapshot.model
        ? formatConfiguredModelEntry(snapshot.provider, snapshot.model)
        : "原始設定";
      await this.safeSend(chatId, `↩️ 已還原至 \`${restoredEntry}\``);
    };

    try {
      if (parsed.provider !== state.provider || !state.client) {
        tempClient = this.createProviderClient(parsed.provider);
        await tempClient.start();
      } else {
        tempClient = state.client;
      }

      const canonicalCwd = await fs.realpath(state.workDir).catch(() => path.resolve(state.workDir!));
      let memoryContext: string | undefined;
      try {
        memoryContext = await this.sessionMemory.buildContext({ chatId, workDir: canonicalCwd });
      } catch {}
      const systemPrompt = await buildPersonaPrompt(canonicalCwd, parsed.provider, memoryContext);
      const approvalMode = resolveApprovalMode(parsed.provider, state.allowAll);

      const tempSession = await tempClient.createSession({
        model: parsed.model,
        workingDirectory: canonicalCwd,
        ...(approvalMode ? { approvalMode } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
        onPermissionRequest: this.createPermissionRequestHandler(chatId, canonicalCwd),
        hooks: {
          onPreToolUse: async (input: any) => {
            const toolName: string | undefined = input?.toolName;
            logger.info("PreToolUse (router)", { tool: toolName });
            const readRestriction = await getReadToolRestriction(
              toolName, input?.toolArgs, canonicalCwd,
              typeof input?.cwd === "string" ? input.cwd : undefined
            );
            if (readRestriction) return { permissionDecision: "deny", permissionDecisionReason: readRestriction };
            if (isWriteOrDeleteTool(toolName)) {
              if (parsed.provider === "copilot") return { permissionDecision: "allow", modifiedArgs: input?.toolArgs };
              const allowed = await this.requestInteractiveApproval(
                chatId, toolName ?? "tool",
                JSON.stringify(input?.toolArgs ?? {}).slice(0, TOOL_PREVIEW_LEN)
              );
              if (!allowed) return { permissionDecision: "deny" };
            }
            return { permissionDecision: "allow", modifiedArgs: input?.toolArgs };
          },
          onPostToolUse: async (input: any) => {
            logger.info("PostToolUse (router)", { tool: input?.toolName });
            return {};
          },
          onErrorOccurred: async (input: any) => {
            logger.warn("AI error hook (router)", { context: input?.errorContext });
            return { errorHandling: "retry" };
          }
        }
      });

      state.provider = parsed.provider;
      state.model = parsed.model;
      state.client = tempClient;
      state.session = tempSession;
      state.sessionVersion += 1;
      const routerVersion = state.sessionVersion;

      tempSession.onEvent((event) => {
        if (state.sessionVersion !== routerVersion) return;
        void this.enqueueEvent(chatId, event);
      });

      this.routerCompletionCallbacks.set(chatId, () => restoreSnapshot(tempSession));

      await this.sendPreparedPrompt(state, prompt, undefined);
    } catch (err) {
      this.routerCompletionCallbacks.delete(chatId);
      const currentSession = state.session;
      state.provider = snapshot.provider;
      state.model = snapshot.model;
      state.mode = snapshot.mode;
      state.client = snapshot.client;
      state.session = snapshot.session;
      if (currentSession && currentSession !== snapshot.session) {
        try { await currentSession.destroy(); } catch {}
      }
      if (tempClient && tempClient !== snapshot.client) {
        try { await tempClient.stop(); } catch {}
      }
      if (snapshot.session) {
        state.sessionVersion += 1;
        const restoredVersion = state.sessionVersion;
        snapshot.session.onEvent((event) => {
          if (state.sessionVersion !== restoredVersion) return;
          void this.enqueueEvent(chatId, event);
        });
      }
      await this.safeSend(chatId, `❌ Router 執行失敗：${String(err)}`);
    }
  }

  private findActiveSessionState(): AgentContext | undefined {
    for (const state of this.states.values()) {
      if (state.session) return state;
    }
    return undefined;
  }

  private async createSession(
    chatId: number,
    cwd: string,
    model?: string,
    options: CreateSessionOptions = {}
  ): Promise<void> {
    const active = this.findActiveSessionState();
    if (active && active.chatId !== chatId) {
      await this.safeSend(chatId, "已有其他聊天的工作階段正在使用中，請先關閉或重設。", undefined);
      return;
    }

    const allowedDirs = await this.loadAllowedDirectories();
    if (!isAllowedDirectory(allowedDirs, cwd)) {
      await this.safeSend(chatId, "專案不在允許列表中。", undefined);
      return;
    }
    const canonicalCwd = await fs.realpath(cwd).catch(() => path.resolve(cwd));

    const state = this.getOrCreateState(chatId);
    if (state.session) {
      try {
        await state.session.destroy();
      } catch (err) {
        if (!isConnectionDisposedError(err)) {
          logger.warn("Destroy session failed", err);
        }
      }
    }
    if (state.client) {
      try {
        await state.client.stop();
      } catch (err) {
        if (!isConnectionDisposedError(err)) {
          logger.warn("Stop client failed", err);
        }
      }
    }
    state.session = undefined;
    state.client = undefined;

    const client = this.createProviderClient(state.provider);
    try {
      await client.start();

      let memoryContext: string | undefined;
      try {
        memoryContext = await this.sessionMemory.buildContext({ chatId, workDir: canonicalCwd });
      } catch (err) {
        logger.warn("Load session memory failed", { chatId, project: path.basename(canonicalCwd), err });
      }

      const systemPrompt = await buildPersonaPrompt(canonicalCwd, state.provider, memoryContext);
      const skillDirectories = state.provider === "copilot"
        ? await this.collectSkillDirectories(canonicalCwd)
        : undefined;
      const approvalMode = resolveApprovalMode(state.provider, state.allowAll);

      const models = await this.getModels(state.provider);
      const useModel = model ?? state.model ?? getDefaultModel(models);
      if (!useModel) {
        throw new Error("未設定模型");
      }

      const session = await client.createSession({
        model: useModel,
        workingDirectory: canonicalCwd,
        ...(approvalMode ? { approvalMode } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(skillDirectories?.length ? { skillDirectories } : {}),
        onPermissionRequest: this.createPermissionRequestHandler(chatId, canonicalCwd),
        hooks: {
          onPreToolUse: async (input: any) => {
            const toolName: string | undefined = input?.toolName;
            logger.info("PreToolUse", { tool: toolName });

            const readRestriction = await getReadToolRestriction(
              toolName,
              input?.toolArgs,
              canonicalCwd,
              typeof input?.cwd === "string" ? input.cwd : undefined
            );
            if (readRestriction) {
              logger.warn("Tool denied by policy", { tool: toolName, reason: readRestriction });
              return {
                permissionDecision: "deny",
                permissionDecisionReason: readRestriction
              };
            }

            if (isWriteOrDeleteTool(toolName)) {
              if (state.provider === "copilot") {
                return { permissionDecision: "allow", modifiedArgs: input?.toolArgs };
              }
              const allowed = await this.requestInteractiveApproval(
                chatId,
                toolName ?? "tool",
                JSON.stringify(input?.toolArgs ?? {}).slice(0, TOOL_PREVIEW_LEN)
              );
              if (!allowed) {
                logger.info("Tool denied by user", { tool: toolName });
                return { permissionDecision: "deny" };
              }
            }

            return { permissionDecision: "allow", modifiedArgs: input?.toolArgs };
          },
          onPostToolUse: async (input: any) => {
            logger.info("PostToolUse", { tool: input?.toolName });
            return {};
          },
          onErrorOccurred: async (input: any) => {
            logger.warn("AI error hook", { context: input?.errorContext });
            return { errorHandling: "retry" };
          }
        }
      });

      state.sessionVersion += 1;
      const capturedVersion = state.sessionVersion;
      session.onEvent((event) => {
        if (state.sessionVersion !== capturedVersion) return;
        void this.enqueueEvent(chatId, event);
      });

      state.client = client;
      state.session = session;
      state.workDir = canonicalCwd;
      state.model = useModel;
      state.processing = false;
      state.pendingTasks = [];
      state.resetting = false;
      state.activePrompt = undefined;
      state.awaitingReply = false;
      state.completionPending = false;
      state.pendingEvents = [];
      state.dispatchingEvents = false;
      state.toolMessageMap.clear();
      state.lastAssistantMessageText = undefined;
      state.sessionCreatedAt = Date.now();
      state.sessionLastActivityAt = state.sessionCreatedAt;
      state.pendingRecovery = undefined;
      state.personaLoaded = true;
      this.clearProcessingTimer(state);

      const projectLabel = path.basename(canonicalCwd);
      const modelLabel = this.formatStateModelLabel(state, useModel);
      if (options.announce !== false) {
        await this.safeSend(chatId, `💎TeleTopaz in ${projectLabel} / 系統訊息\n\n📂 ${projectLabel}\n⚙️ ${modelLabel}\n🔌 已連線`, undefined, this.buildNavKeyboard());
        await this.sendStatusFooter(chatId);
      }
    } catch (err) {
      await client.stop().catch((stopErr) => {
        if (!isConnectionDisposedError(stopErr)) logger.warn("Stop client failed", stopErr);
      });
      await this.safeSend(chatId, `建立工作階段失敗：${String(err)}`, undefined);
    }
  }

  private async enqueueEvent(chatId: number, event: AiEvent): Promise<void> {
    const state = this.getOrCreateState(chatId);
    const type = event.type ?? (event as { event?: string }).event ?? "unknown";
    logger.info("AI event", { chatId, type, provider: state.provider, model: state.model });
    state.pendingEvents.push(event);
    if (state.dispatchingEvents) return;
    state.dispatchingEvents = true;

    while (state.pendingEvents.length) {
      const next = state.pendingEvents.shift();
      if (!next) continue;
      try {
        await this.handleEvent(chatId, next);
      } catch (err) {
        logger.error("Event handler error", err);
      }
    }

    state.dispatchingEvents = false;
  }

  private async handleEvent(chatId: number, event: AiEvent): Promise<void> {
    const state = this.getOrCreateState(chatId);
    const type = event.type ?? (event as { event?: string }).event;
    const data = event.data ?? event;
    if (type && state.session) {
      this.touchSession(state);
    }

    switch (type) {
      case "assistant.message": {
        const content = this.extractText(data);
        if (content) {
          const hash = this.hashText(content);
          if (state.lastAssistantMessageHash === hash) {
            return;
          }
          state.lastAssistantMessageHash = hash;
          const editTarget = state.processingMessageId
            ?? (state.silentMode ? state.silentAnchorMessageId : undefined);
          if (editTarget && content.length <= 3500) {
            await this.editMessageSafe(chatId, editTarget, content);
            state.processingMessageId = undefined;
          } else {
            // 長回覆或無 anchor：silent mode 下靜音推送，並將 anchor 更新為 ✅完成
            const silent = state.silentMode && !!state.silentAnchorMessageId;
            await this.sendAssistantMessage(chatId, content, state.replyToMessageId, silent);
            if (editTarget) {
              await this.editMessageSafe(chatId, editTarget, "✅完成");
              state.processingMessageId = undefined;
            }
          }
          state.awaitingReply = false;
          state.receivedAssistantMessage = true;
          state.lastAssistantMessageText = content;
          this.clearProcessingTimer(state);
          if (state.completionPending && state.pendingTasks.length === 0) {
            state.completionPending = false;
            await this.sendDoneNotice(chatId, state);
            await this.sendStatusFooter(chatId);
          }
        }
        return;
      }
      case "assistant.message_delta": {
        // Ignore delta to avoid duplicate replies; use final assistant.message only.
        return;
      }
      case "tool.execution_start": {
        await this.handleToolStart(chatId, state, data);
        return;
      }
      case "tool.execution_complete": {
        await this.handleToolComplete(chatId, state, data);
        return;
      }
      case "session.idle": {
        state.processing = false;
        const completedPrompt = state.activePrompt;
        const completedReply = state.lastAssistantMessageText;
        state.activePrompt = undefined;
        state.lastAssistantMessageText = undefined;
        this.clearProcessingTimer(state);
        await this.persistSessionMemory(chatId, state.workDir, completedPrompt, completedReply);
        const routerCallback = this.routerCompletionCallbacks.get(chatId);
        if (routerCallback) {
          this.routerCompletionCallbacks.delete(chatId);
          await routerCallback();
          // After restoring state, fall through to handle pending tasks with restored session
        }
        if (state.pendingTasks.length === 0) {
          if (state.awaitingReply) {
            state.completionPending = true;
          } else if (!state.receivedAssistantMessage) {
            await this.sendDoneNotice(chatId, { ...state, activePrompt: completedPrompt });
            await this.sendStatusFooter(chatId);
          } else {
            await this.sendStatusFooter(chatId);
          }
          return;
        }
        const nextTask = state.pendingTasks.shift();
        if (!nextTask) return;
        const nextPrompt = nextTask.prompt;
        state.processing = true;
        state.activePrompt = nextPrompt;
        state.promptCycles += 1;
        state.awaitingReply = true;
        state.completionPending = false;
        state.receivedAssistantMessage = false;
        state.lastAssistantMessageHash = undefined;
        state.lastAssistantMessageText = undefined;
        state.silentAnchorMessageId = undefined;
        const enqueuedText = `⏳處理中：${nextPrompt.slice(0, 80)}`;
        const processing = state.silentMode
          ? await this.silentSend(chatId, enqueuedText, state.replyToMessageId)
          : await this.safeSend(chatId, enqueuedText, state.replyToMessageId);
        state.processingMessageId = processing?.message_id ?? (state.silentMode ? state.silentAnchorMessageId : undefined);
        const policy = await this.guardrailsPromise;
        const promptLimit = policy.maxPromptLength ?? MESSAGE_LIMIT;
        const sendResult = await this.sendPrompt(state, nextPrompt, state.replyToMessageId, promptLimit);
        if (sendResult.chunked && sendResult.totalChunks > 1) {
          const chunkNotice = `提示詞過長，已拆分為 ${sendResult.totalChunks} 段送出以維持完整內容。`;
          if (state.silentMode) {
            await this.silentSend(chatId, chunkNotice, state.replyToMessageId);
          } else {
            await this.safeSend(chatId, chunkNotice, state.replyToMessageId);
          }
        }
        return;
      }
      default:
        return;
    }
  }

  private extractText(payload: unknown): string | undefined {
    if (!payload) return undefined;
    if (typeof payload === "string") return payload;
    if (typeof payload === "object") {
      const record = payload as Record<string, unknown>;
      const content = record.content ?? record.message ?? record.text ?? record.delta;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const item of content) {
          if (typeof item === "string") {
            parts.push(item);
            continue;
          }
          if (item && typeof item === "object") {
            const text = (item as Record<string, unknown>).text;
            if (typeof text === "string") parts.push(text);
          }
        }
        if (parts.length) return parts.join("");
      }
      if (record.message && typeof record.message === "object") {
        const msg = record.message as Record<string, unknown>;
        const msgContent = msg.content;
        if (typeof msgContent === "string") return msgContent;
        if (Array.isArray(msgContent)) {
          const parts: string[] = [];
          for (const item of msgContent) {
            if (typeof item === "string") parts.push(item);
            else if (item && typeof item === "object") {
              const text = (item as Record<string, unknown>).text;
              if (typeof text === "string") parts.push(text);
            }
          }
          if (parts.length) return parts.join("");
        }
      }
    }
    return undefined;
  }

  private async persistSessionMemory(
    chatId: number,
    workDir: string | undefined,
    prompt: string | undefined,
    reply: string | undefined
  ): Promise<void> {
    if (!workDir) return;

    const entries: Array<{ role: "user" | "assistant"; text: string | undefined }> = [
      { role: "user", text: prompt ? stripAttachmentContext(prompt) : undefined },
      { role: "assistant", text: reply }
    ];

    for (const entry of entries) {
      const text = entry.text?.trim();
      if (!text) continue;
      try {
        await this.sessionMemory.append({ chatId, workDir }, entry.role, text);
      } catch (err) {
        logger.warn("Session memory append failed", {
          chatId,
          project: path.basename(workDir),
          role: entry.role,
          err
        });
      }
    }
  }

  private async handleToolStart(chatId: number, state: AgentContext, payload: unknown): Promise<void> {
    const record = payload as Record<string, unknown>;
    const name = this.extractString(record, ["toolName", "name", "tool", "functionName"]);
    const callId = this.extractString(record, ["toolCallId", "callId", "id", "tool_call_id", "parentId"]);
    const args = record.args ?? record.arguments ?? record.params ?? record.input;
    const argsText = args ? formatJsonResult(args) ?? String(args) : "";

    const paramsKey = this.createResultKey(chatId);
    const resultKey = this.createResultKey(chatId);
    const summary = redact((argsText ?? "").slice(0, TOOL_PREVIEW_LEN));
    const toolText = `工具執行中：${name ?? "未知"}\n參數摘要：${summary}`;

    if (state.silentMode) {
      await this.silentSend(chatId, toolText);
      if (argsText) this.toolParams.set(paramsKey, redact(argsText));
      if (callId) {
        const tracking: ToolTracking = {
          messageId: state.silentAnchorMessageId ?? 0,
          resultKey,
          paramsKey
        };
        if (name) tracking.toolName = name;
        tracking.callId = callId;
        state.toolMessageMap.set(callId, tracking);
      }
      return;
    }

    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: "📋 參數", callback_data: `peek.arg:${paramsKey}` },
          { text: "📄 結果", callback_data: `peek.res:${resultKey}` }
        ]
      ]
    };

    const message = await this.safeSend(
      chatId,
      toolText,
      undefined,
      keyboard
    );

    if (argsText) this.toolParams.set(paramsKey, redact(argsText));

    if (message) {
      const tracking: ToolTracking = {
        messageId: message.message_id,
        resultKey,
        paramsKey
      };
      if (name) tracking.toolName = name;
      if (callId) tracking.callId = callId;
      if (callId) {
        state.toolMessageMap.set(callId, tracking);
      }
    }
  }

  private async handleToolComplete(chatId: number, state: AgentContext, payload: unknown): Promise<void> {
    const record = payload as Record<string, unknown>;
    const callId = this.extractString(record, ["toolCallId", "callId", "id", "tool_call_id", "parentId"]);
    const tracking = callId ? state.toolMessageMap.get(callId) : undefined;

    const result = record.result ?? record.output ?? record.response ?? record.data;
    const error = record.error ?? record.err;
    const resultText = formatJsonResult(result ?? error) ?? "";

    const policy = await this.guardrailsPromise;
    const guarded = guardToolOutput(policy, resultText);
    const summary = redact(guarded.text.slice(0, TOOL_PREVIEW_LEN));
    const status = error ? "失敗" : "完成";

    if (tracking) {
      this.toolResults.set(tracking.resultKey, guarded.text);

      if (state.silentMode && state.silentAnchorMessageId) {
        await this.editMessageSafe(
          chatId,
          state.silentAnchorMessageId,
          `工具${status}：${tracking.toolName ?? "未知"}\n結果摘要：${summary}`
        );
      } else {
        await this.editMessageSafe(
          chatId,
          tracking.messageId,
          `工具${status}：${tracking.toolName ?? "未知"}\n結果摘要：${summary}`,
          {
            inline_keyboard: [
              [
                { text: "📋 參數", callback_data: `peek.arg:${tracking.paramsKey}` },
                { text: "📄 結果", callback_data: `peek.res:${tracking.resultKey}` }
              ]
            ]
          }
        );
        const desiredEmoji = error ? "❌" : "✅";
        let reactionEmoji = this.pickReactionEmoji(state, desiredEmoji);
        if (reactionEmoji) {
          try {
            await this.api.setMessageReaction({
              chat_id: chatId,
              message_id: tracking.messageId,
              reaction: [{ type: "emoji", emoji: reactionEmoji }]
            });
          } catch (err) {
            if (isTelegramReactionInvalid(err)) {
              await this.refreshReactionEmojis(chatId, state);
              reactionEmoji = this.pickReactionEmoji(state, desiredEmoji);
              if (reactionEmoji) {
                try {
                  await this.api.setMessageReaction({
                    chat_id: chatId,
                    message_id: tracking.messageId,
                    reaction: [{ type: "emoji", emoji: reactionEmoji }]
                  });
                } catch (retryErr) {
                  logger.warn("Set reaction retry failed", retryErr);
                }
              }
            } else {
              logger.warn("Set reaction failed", err);
            }
          }
        }
      }
      if (callId) state.toolMessageMap.delete(callId);
    }
  }

  private pickReactionEmoji(state: AgentContext, desired: string): string | undefined {
    if (!state.reactionEmojis) return desired;
    if (state.reactionEmojis.length === 0) return undefined;
    if (state.reactionEmojis.includes(desired)) return desired;
    return state.reactionEmojis[0];
  }

  private async refreshReactionEmojis(chatId: number, state: AgentContext): Promise<void> {
    try {
      const chat = await this.api.getChat(chatId);
      const available = (chat as { available_reactions?: unknown }).available_reactions;
      if (Array.isArray(available)) {
        const emojis = available
          .map((item) => {
            if (!item || typeof item !== "object") return undefined;
            const record = item as { type?: string; emoji?: string };
            if (record.type === "emoji" && typeof record.emoji === "string") return record.emoji;
            return undefined;
          })
          .filter((emoji): emoji is string => Boolean(emoji));
        state.reactionEmojis = emojis;
      } else {
        state.reactionEmojis = [];
      }
    } catch (err) {
      logger.warn("Load available reactions failed", err);
    }
  }

  private extractString(record: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string") return value;
    }
    return undefined;
  }

  private async sendAssistantMessage(chatId: number, text: string, replyTo?: number, disableNotification?: boolean): Promise<void> {
    const state = this.getOrCreateState(chatId);
    let content = text;
    if ((state as any).pendingFooter) {
      content += (state as any).pendingFooter;
      (state as any).pendingFooter = undefined;
    }

    if (!content.trim()) {
      logger.warn("Assistant message empty", { chatId });
      return;
    }
    await this.safeSend(chatId, content, replyTo, undefined, disableNotification ? { disableNotification: true } : undefined);
  }

  private async sendDoneNotice(chatId: number, state: AgentContext): Promise<void> {
    if (state.silentMode) {
      const summary = state.receivedAssistantMessage
        ? "✅完成"
        : `✅完成：${state.activePrompt?.slice(0, 80) ?? ""}`;
      await this.silentSend(chatId, summary);
      return;
    }
    if (state.processingMessageId) {
      const summary = state.receivedAssistantMessage
        ? "✅完成"
        : `✅完成：${state.activePrompt?.slice(0, 80) ?? ""}`;
      await this.editMessageSafe(chatId, state.processingMessageId, summary);
      state.processingMessageId = undefined;
    } else {
      await this.safeSend(chatId, `${state.sessionIcon} ✅ 任務完成`, state.replyToMessageId);
    }
  }

  private prepareOutgoingRaw(chatId: number, text: string, source?: string): string {
    const state = this.getOrCreateState(chatId);
    const trimmed = text.trimStart();
    // Skip adding header if the text already starts with the 💎 header
    if (trimmed.startsWith("💎TeleTopaz")) {
      return redact(text);
    }

    const iconPool = getIconPool();
    const hasPoolHeader = iconPool.some((icon) => trimmed.startsWith(icon));
    const hasEmojiHeader = /^\p{Extended_Pictographic}/u.test(trimmed);
    const hasHeader = hasPoolHeader || hasEmojiHeader;

    const projectLabel = state.workDir ? path.basename(state.workDir) : "尚未選擇專案";
    const messageSource = source ?? this.formatActiveSource(state);
    const header = `💎TeleTopaz in ${projectLabel} / ${messageSource}`;

    const withHeader = hasHeader ? text : `${header}\n${text}`;
    return redact(withHeader);
  }

  private prepareOutgoingText(chatId: number, text: string, source?: string): string {
    return markdownToTelegram(this.prepareOutgoingRaw(chatId, text, source));
  }

  private async safeSend(
    chatId: number,
    text: string,
    replyTo?: number,
    keyboard?: InlineKeyboardMarkup,
    options?: { disableNotification?: boolean }
  ): Promise<TelegramMessage | undefined> {
    const redacted = this.prepareOutgoingRaw(chatId, text);
    const chunks = splitLongMessage(redacted, MESSAGE_LIMIT);
    let lastMessage: TelegramMessage | undefined;
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index] ?? "";
      const reply = index === 0 ? replyTo : undefined;
      const payload = {
        chat_id: chatId,
        text: markdownToTelegram(chunk),
        parse_mode: "MarkdownV2",
        ...(reply !== undefined ? { reply_to_message_id: reply } : {}),
        ...(index === 0 && keyboard ? { reply_markup: keyboard } : {}),
        disable_web_page_preview: true,
        ...(options?.disableNotification ? { disable_notification: true } : {})
      };
      try {
        lastMessage = await this.api.sendMessage(payload);
      } catch {
        const fallback = chunk.replace(/[*_~`]/g, "");
        try {
          lastMessage = await this.api.sendMessage({
            chat_id: chatId,
            text: fallback,
            ...(reply !== undefined ? { reply_to_message_id: reply } : {}),
            ...(index === 0 && keyboard ? { reply_markup: keyboard } : {}),
            disable_web_page_preview: true,
            ...(options?.disableNotification ? { disable_notification: true } : {})
          });
        } catch (err) {
          logger.error("Send message failed", err);
          throw err;
        }
      }
    }
    return lastMessage;
  }

  private async editMessageSafe(
    chatId: number,
    messageId: number,
    text: string,
    keyboard?: InlineKeyboardMarkup
  ): Promise<void> {
    try {
      await this.api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: this.prepareOutgoingText(chatId, text),
        parse_mode: "MarkdownV2",
        ...(keyboard ? { reply_markup: keyboard } : {})
      });
      return;
    } catch (err) {
      if (isTelegramNotModifiedError(err)) {
        return; // 內容未變動，視為成功
      }
      logger.warn("Edit message failed, fallback to plain text", err);
    }
    try {
      await this.api.editMessageTextPlain({
        chat_id: chatId,
        message_id: messageId,
        text: redact(text).replace(/[*_~`]/g, ""),
        ...(keyboard ? { reply_markup: keyboard } : {})
      });
    } catch (err) {
      if (isTelegramNotModifiedError(err)) {
        return; // 內容未變動，視為成功
      }
      logger.warn("Edit message plain failed, fallback to send", err);
      await this.safeSend(chatId, text, undefined, keyboard);
    }
  }

  private async silentSend(
    chatId: number,
    text: string,
    replyTo?: number
  ): Promise<TelegramMessage | undefined> {
    const state = this.getOrCreateState(chatId);
    if (state.silentAnchorMessageId) {
      await this.editMessageSafe(chatId, state.silentAnchorMessageId, text);
      return undefined;
    }
    const msg = await this.safeSend(chatId, text, replyTo);
    if (msg) {
      state.silentAnchorMessageId = msg.message_id;
    }
    return msg;
  }

  private getOrCreateState(chatId: number): AgentContext {
    const existing = this.states.get(chatId);
    if (existing) return existing;

    const used = new Set(Array.from(this.states.values()).map((state) => state.sessionIcon));
    const icon = pickIcon(used);

    const state: AgentContext = {
      chatId,
      provider: "copilot",
      client: undefined,
      session: undefined,
      workDir: undefined,
      model: undefined,
      mode: "auto",
      routerModel: DEFAULT_ROUTER_MODEL,
      coreModel: DEFAULT_CORE_MODEL,
      processing: false,
      pendingTasks: [],
      resetting: false,
      attachments: [],
      sessionIcon: icon,
      activePrompt: undefined,
      toolMessageMap: new Map(),
      awaitingReply: false,
      completionPending: false,
      pendingEvents: [],
      dispatchingEvents: false,
      replyToMessageId: undefined,
      processingMessageId: undefined,
      processingTimer: undefined,
      receivedAssistantMessage: false,
      lastAssistantMessageHash: undefined,
      lastAssistantMessageText: undefined,
      promptCycles: 0,
      sessionCreatedAt: undefined,
      sessionLastActivityAt: undefined,
      pendingRecovery: undefined,
      lastProactiveRebuildNotice: undefined,
      starredModels: [],
      cachedDirs: [],
      personaLoaded: false,
      reactionEmojis: null,
      allowAll: false,
      silentMode: true,
      silentAnchorMessageId: undefined,
      sessionVersion: 0
    };

    this.states.set(chatId, state);
    return state;
  }

  private async loadAllowedDirectories(): Promise<string[]> {
    const runtimeConfig = await loadConfiguredRuntimeConfig();
    const patterns = await loadDirectoryPatterns(runtimeConfig.directoryPatterns);
    return expandDirectoryPatterns(patterns);
  }

  /** Ensure a TempNote directory exists within the allowed directories. */
  private async ensureTempNoteDirectory(dirs: string[]): Promise<void> {
    const existing = dirs.find((d) => path.basename(d) === "TempNote");
    if (existing) {
      logger.info("TempNote directory found", existing);
      return;
    }
    // Create TempNote under the parent of the first allowed directory (or first directory itself)
    if (!dirs.length) {
      logger.warn("No allowed directories to create TempNote in");
      return;
    }
    const parentDir = path.dirname(dirs[0]!);
    const tempNotePath = path.join(parentDir, "TempNote");
    try {
      await fs.mkdir(tempNotePath, { recursive: true });
      logger.info("TempNote directory created", tempNotePath);
    } catch (err) {
      logger.warn("Failed to create TempNote directory", err);
    }
  }

  private async getModels(provider?: ProviderType): Promise<string[]> {
    const p = provider ?? "copilot";
    const now = Date.now();
    const cached = this.modelsCache.get(p);
    if (cached && now - cached.fetchedAt < this.modelsTtlMs) {
      return cached.models;
    }
    const models = await loadSupportedModels(p);
    this.modelsCache.set(p, { models, fetchedAt: now });
    return models;
  }

  private async findSkillsPath(cwd: string): Promise<string | undefined> {
    const candidate = path.join(cwd, ".github", "skills");
    try {
      const workspaceRoot = await fs.realpath(cwd);
      const resolved = await fs.realpath(candidate);
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) {
        return undefined;
      }

      const relative = path.relative(workspaceRoot, resolved);
      const staysWithinWorkspace = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
      if (!staysWithinWorkspace) {
        logger.warn("Ignoring skills path outside workspace", { cwd: workspaceRoot, resolved });
        return undefined;
      }

      return resolved;
    } catch {
      return undefined;
    }
  }

  private async collectSkillDirectories(cwd: string): Promise<string[] | undefined> {
    const directories = new Set<string>();

    try {
      const bundled = await fs.stat(BUNDLED_SKILLS_PATH);
      if (bundled.isDirectory()) {
        directories.add(BUNDLED_SKILLS_PATH);
      }
    } catch {
      // ignore missing bundled skills
    }

    const workspaceSkills = await this.findSkillsPath(cwd);
    if (workspaceSkills) {
      directories.add(workspaceSkills);
    }

    return directories.size > 0 ? Array.from(directories) : undefined;
  }

  private createResultKey(chatId: number): string {
    const rand = crypto.randomBytes(6).toString("hex");
    return `${Date.now().toString(36)}${rand}`;
  }

  private hashText(text: string): string {
    return crypto.createHash("sha1").update(text).digest("hex");
  }

  private async fetchProviderInfo(provider: ProviderType = "copilot"): Promise<string | undefined> {
    try {
      const client = this.createProviderClient(provider);
      await client.start();
      const info = await client.queryProviderInfo();
      await client.stop();

      if (info.modelsRaw && info.modelsRaw.length) {
        return this.formatModelGroups(info.modelsRaw);
      }
      if (info.models?.length) {
        return this.formatModelGroups(info.models);
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private createProviderClient(provider: ProviderType): AiClient {
    return createProviderClient(provider);
  }

  private resolveProviderForModel(model: string): ProviderType {
    return parseConfiguredModelEntry(model).provider;
  }

  private formatModelEntry(provider: ProviderType, model: string): string {
    return formatConfiguredModelEntry(provider, model);
  }

  private formatResolvedModelEntry(model: string | undefined): string {
    if (!model) return "未設定";
    return this.formatModelEntry(this.resolveProviderForModel(model), model);
  }

  private formatStoredModelKey(model: string): string {
    if (model.includes(":")) {
      return normalizeConfiguredModelEntry(model, this.formatResolvedModelEntry(parseConfiguredModelEntry(model).model));
    }
    return this.formatResolvedModelEntry(model);
  }

  private formatStateModelLabel(state: AgentContext, manualModelOverride?: string): string {
    if (state.mode === "auto") {
      const activeModel = manualModelOverride ?? state.model;
      const activePrefix = activeModel ? `目前:${this.formatResolvedModelEntry(activeModel)} / ` : "";
      return `Auto (${activePrefix}R:${this.formatResolvedModelEntry(state.routerModel)} / C:${this.formatResolvedModelEntry(state.coreModel)})`;
    }
    return this.formatModelEntry(state.provider, manualModelOverride ?? state.model ?? "未設定");
  }

  private formatActiveSource(state: AgentContext): string {
    if (state.mode === "auto") {
      return state.model ? `Auto:${this.formatResolvedModelEntry(state.model)}` : "Auto:待路由";
    }
    return this.formatModelEntry(state.provider, state.model ?? "未設定");
  }

  private buildNavKeyboard(): InlineKeyboardMarkup {
    const shortcuts = SHORTCUT_BUTTONS.map((sc) => ({
      text: sc.label,
      callback_data: `do.shortcut:${sc.callbackKey}`,
    }));

    return {
      inline_keyboard: [
        [
          { text: "📁 專案", callback_data: "do.project" },
          { text: "⚙️ 模型", callback_data: "do.model" },
          { text: "📋 說明", callback_data: "do.info" }
        ],
        shortcuts,
      ],
    };
  }

  private async buildStatusBlock(chatId: number): Promise<string> {
    const ownerName = await this.fetchOwnerName();
    const state = this.getOrCreateState(chatId);
    const projectLabel = state.workDir ? path.basename(state.workDir) : "未選擇";
    const modelLabel = this.formatStateModelLabel(state);

    return [
      "💎TeleTopaz in " + projectLabel + " / 系統訊息",
      "",
      `👤 ${ownerName}`,
      `⚙️ ${modelLabel}`,
      `📂 ${projectLabel}`,
      `🔐 操作確認：${state.allowAll ? "全部允許" : "逐次確認"}`,
      `🔇 安靜模式：${state.silentMode ? "開啟" : "關閉"}`,
      "",
      "📌 指令：",
      "/project — 選擇專案","",
      "/newproject — 建立新專案（例：/newproject MyApp）","",
      "/model — 切換 AI 模型 (Auto/Manual)","",
      "/info — 說明","",
      "/clear — 清除對話與附件","",
      "/router {prompt} — 使用 routerModel 執行單次對話，完成後自動還原","",
      "/allowall — 切換全部允許/操作確認模式","",
      "/silent — 切換安靜/正常通知模式","",
      "/restart — 熱啟動","",
      "/quit — 關閉Bot","",
      "/help — 顯示說明與指令列表"
    ].join("\n");
  }

  private async sendStatusFooter(chatId: number): Promise<void> {
    const state = this.getOrCreateState(chatId);
    if (state.silentMode) {
      return; // silent mode 不主動推送系統狀態，使用者可用 /info 主動查看
    }
    const text = await this.buildStatusBlock(chatId);
    await this.safeSend(chatId, text.trim(), undefined, this.buildNavKeyboard());
  }

  private async sendWelcome(providerInfo: string | undefined, dirs: string[], models: string[], message?: TelegramMessage): Promise<void> {
    const chatId = Number(this.ownerChatId);
    const text = await this.buildStatusBlock(chatId);
    await this.safeSend(chatId, text.trim(), message?.message_id, this.buildNavKeyboard());
  }

  private async fetchOwnerName(): Promise<string> {
    try {
      const chat = await this.api.getChat(this.ownerChatId);
      return formatChatDisplayName(chat);
    } catch {
      return "未知";
    }
  }

  private formatServerTime(): string {
    const now = new Date();
    const datePart = now.toLocaleDateString("zh-TW");
    const timePart = now.toLocaleTimeString("zh-TW");
    return `${datePart} ${timePart}`;
  }

  private formatModelGroups(modelsRaw: unknown[]): string {
    const infos = normalizeModelInfos(modelsRaw);
    const grouped = new Map<string, string[]>();
    for (const info of infos) {
      const provider = this.inferProvider(info.name, info.provider);
      const list = grouped.get(provider) ?? [];
      list.push(info.name);
      grouped.set(provider, list);
    }
    const total = infos.length;
    const lines: string[] = [`⚙️ 可用模型（共 ${total} 個）`];
    for (const [provider, names] of grouped.entries()) {
      lines.push(`${provider}:`);
      for (const name of names) {
        lines.push(`  • ${name}`);
      }
    }
    return lines.join("\n");
  }

  private inferProvider(modelName: string, provider?: string): string {
    const raw = (provider ?? modelName).toLowerCase();
    if (raw.includes("openai") || raw.startsWith("gpt") || raw.includes("o1") || raw.includes("o3")) {
      return "OpenAI";
    }
    if (raw.includes("anthropic") || raw.includes("claude")) {
      return "Anthropic";
    }
    if (raw.includes("google") || raw.includes("gemini")) {
      return "Google";
    }
    if (raw.includes("cohere")) {
      return "Cohere";
    }
    if (raw.includes("mistral")) {
      return "Mistral";
    }
    return "Other";
  }

  // ── Hot Restart ──────────────────────────────────────────

  private async handleRestart(chatId: number): Promise<void> {
    if (this.restartConfirmTimer) {
      clearTimeout(this.restartConfirmTimer);
      this.restartConfirmTimer = undefined;
    }

    await this.safeSend(chatId, "🔄 正在準備熱啟動...");

    let gitInfo: { sha: string; hasUncommittedChanges: boolean };
    try {
      gitInfo = getGitInfo(process.cwd());
    } catch (err) {
      await this.safeSend(chatId, `❌ 無法取得 git 資訊：${String(err)}`);
      return;
    }

    const state: RestartState = {
      triggeredBy: "user",
      triggeredAt: Date.now(),
      previousGitSha: gitInfo.sha,
      hadUncommittedChanges: gitInfo.hasUncommittedChanges,
      rollbackCount: 0,
    };
    saveRestartState(state);

    await this.safeSend(chatId, "🔄 熱啟動中，服務將在數秒內重新上線...");
    await this.shutdownForRestart();
  }

  private async checkRestartConfirmation(): Promise<void> {
    const state = loadRestartState();
    if (!state) return;

    const chatId = Number(this.ownerChatId);
    const rollbackLabel = state.rollbackCount > 0 ? "（退版後重啟）" : "";
    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: "✅ 服務正常", callback_data: "restart.confirm" },
          { text: "🔙 退版重啟", callback_data: "restart.deny" },
        ],
      ],
    };

    const msg = await this.safeSend(
      chatId,
      `🔄 熱啟動完成${rollbackLabel}！請確認服務是否正常運作。\n（5 分鐘內未確認將自動退版重啟）`,
      undefined,
      keyboard
    );
    if (msg) this.restartConfirmMessageId = msg.message_id;

    this.restartConfirmTimer = setTimeout(() => {
      this.handleRestartTimeout(chatId).catch((err) =>
        logger.error("Restart timeout handler error", err)
      );
    }, 5 * 60 * 1000);
  }

  private async handleRestartTimeout(chatId: number): Promise<void> {
    this.restartConfirmTimer = undefined;
    const state = loadRestartState();
    if (!state) return;

    if (state.triggeredBy === "system") {
      await this.safeSend(chatId, "⛔ 退版後仍未收到確認，服務即將中斷。");
      if (this.restartConfirmMessageId) {
        await this.editMessageSafe(chatId, this.restartConfirmMessageId, "⛔ 已逾時，服務中斷。");
      }
      clearRestartState();
      await this.withTimeout(logger.flush(), 4000).catch(() => {});
      process.exit(1);
      return;
    }

    if (state.triggeredBy === "user" && state.rollbackCount < 1) {
      await this.handleRestartRollback(chatId);
      return;
    }

    clearRestartState();
    await this.withTimeout(logger.flush(), 4000).catch(() => {});
    process.exit(1);
  }

  private async handleRestartRollback(chatId: number): Promise<void> {
    const state = loadRestartState();
    if (!state) {
      await this.safeSend(chatId, "❌ 找不到重啟狀態，無法退版。");
      return;
    }

    await this.safeSend(chatId, "🔙 正在退版並重新啟動...");

    try {
      performGitRollback(process.cwd(), state);
    } catch (err) {
      await this.safeSend(chatId, `❌ Git 退版失敗：${String(err)}\n服務即將中斷。`);
      clearRestartState();
      await this.withTimeout(logger.flush(), 4000).catch(() => {});
      process.exit(1);
      return;
    }

    const updatedState: RestartState = {
      ...state,
      triggeredBy: "system",
      rollbackCount: state.rollbackCount + 1,
    };
    saveRestartState(updatedState);

    await this.shutdownForRestart();
  }

  private async shutdownForRestart(): Promise<void> {
    if (this.restartConfirmTimer) {
      clearTimeout(this.restartConfirmTimer);
      this.restartConfirmTimer = undefined;
    }
    this.shuttingDown = true;
    this.running = false;
    const tasks: Promise<void>[] = [];

    if (this.intentClassifierClient) {
      tasks.push(this.resetIntentClassifierClient());
    }

    for (const s of this.states.values()) {
      if (s.session) {
        tasks.push(
          this.withTimeout(s.session.destroy(), 6000).catch((err) => {
            if (!isConnectionDisposedError(err)) logger.warn("Destroy session failed", err);
          })
        );
      }
      if (s.client) {
        tasks.push(
          this.withTimeout(s.client.stop(), 4000).catch((err) => {
            if (!isConnectionDisposedError(err)) logger.warn("Stop client failed", err);
          })
        );
      }
    }

    await this.withTimeout(Promise.all(tasks).then(() => undefined), 12000).catch((err) => logger.error(err));
    await this.withTimeout(logger.flush(), 4000).catch((err) => logger.error("Log flush failed", err));
    process.exit(EXIT_CODE_RESTART);
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.running = false;
    const tasks: Promise<void>[] = [];

    if (this.intentClassifierClient) {
      tasks.push(this.resetIntentClassifierClient());
    }

    for (const state of this.states.values()) {
      if (state.session) {
        tasks.push(
          this.withTimeout(state.session.destroy(), 6000).catch((err) => {
            if (!isConnectionDisposedError(err)) logger.warn("Destroy session failed", err);
          })
        );
      }
      if (state.client) {
        tasks.push(
          this.withTimeout(state.client.stop(), 4000).catch((err) => {
            if (!isConnectionDisposedError(err)) logger.warn("Stop client failed", err);
          })
        );
      }
    }

    await this.withTimeout(Promise.all(tasks).then(() => undefined), 12000).catch((err) => logger.error(err));
    await this.withTimeout(logger.flush(), 4000).catch((err) => logger.error("Log flush failed", err));
    process.exit(0);
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeoutId: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
}
