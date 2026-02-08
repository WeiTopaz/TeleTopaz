import crypto from "node:crypto";
import path from "node:path";
import { TelegramApi } from "./telegram/api.js";
import { InlineKeyboardMarkup, TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from "./telegram/types.js";
import { loadSecrets } from "./config/secrets.js";
import { loadDirectoryPatterns, expandDirectoryPatterns, isAllowedDirectory } from "./config/directories.js";
import { loadGuardrails, evaluatePrompt, evaluatePromptIgnoringLength, guardToolOutput } from "./guardrails/guardrails.js";
import { redact } from "./util/redaction.js";
import { markdownToTelegram, splitLongMessage } from "./util/markdown.js";
import { formatChatDisplayName, formatJsonResult, parseIndex } from "./util/format.js";
import { logger } from "./util/logger.js";
import { parseFingerprints } from "./util/tls.js";
import { CopilotSdkClient, CopilotEvent, normalizeModelInfos } from "./copilot/sdk.js";
import { AgentContext, ToolTracking, PendingTask } from "./session/state.js";
import { getIconPool, pickIcon } from "./session/emoji.js";
import { buildPersonaPrompt } from "./session/persona.js";
import { buildPromptChunks, composePrompt } from "./session/prompt.js";
import { reencodePhoto } from "./util/images.js";
import { isConnectionDisposedError, isTelegramReactionInvalid } from "./util/errors.js";
import { loadSupportedModels, getDefaultModel } from "./config/models.js";

const MESSAGE_LIMIT = 4096;
const PENDING_LIMIT = 15;
const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const TOOL_PREVIEW_LEN = 150;

/** Tool names that perform write or delete operations requiring human confirmation. */
const WRITE_DELETE_TOOLS = new Set([
  "editFile", "createFile", "deleteFile", "renameFile",
  "write", "create", "edit", "delete", "remove", "rename",
  "shell", "bash", "terminal", "exec",
]);

/** Returns true when the tool name implies a write/delete side-effect. */
function isWriteOrDeleteTool(name: string | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  if (WRITE_DELETE_TOOLS.has(lower)) return true;
  if (/\b(write|delete|remove|create|edit|patch|mv|rm)\b/i.test(lower)) return true;
  return false;
}

const TOOL_CONFIRM_TIMEOUT_MS = 120_000;

const COMMANDS = [
  "/start",
  "/help",
  "/project",
  "/engine",
  "/info",
  "/i",
  "/new",
  "/imgclear",
  "/bye"
];

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
  private modelsCache: { models: string[]; fetchedAt: number } | undefined;
  private readonly modelsTtlMs = 5 * 60 * 1000;
  private running = true;
  private offset = 0;
  private shuttingDown = false;

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
    logger.info("Allowed directories", directories);

    await this.clearOfflineUpdates();

    const providerInfo = await this.fetchProviderInfo();
    const defaultModel = getDefaultModel(models);
    if (defaultModel) {
      const state = this.getOrCreateState(Number(this.ownerChatId));
      if (!state.engine) state.engine = defaultModel;
    }
    logger.info("Bot started at", Math.floor(Date.now() / 1000));
    logger.info("💎 TeleTopaz 已啟動");
    logger.info(`🗂️ ${directories.length} 個可用目錄`);
    if (defaultModel) {
      logger.info(`🤖 使用預設模型: ${defaultModel}`);
    }
    if (directories.length) {
      logger.info("可用目錄:");
      directories.forEach((dir, index) => {
        logger.info(`  ${index + 1}. ${dir}`);
      });
    }
    logger.info("✅ 可用命令：");
    logger.info("  /project - 選擇工作區");
    logger.info("  /engine - 切換引擎");
    logger.info("  /info - 檢視狀態");
    logger.info("  /new - 重啟對話");
    logger.info("  /imgclear - 清除附件");
    logger.info("  /bye - 關閉Bot");
    logger.info("  /help - 顯示說明與指令列表");
    try {
      await this.sendWelcome(providerInfo, directories, models);
      logger.info(`Welcome message and provider info sent to owner (chatId: ${this.ownerChatId})`);
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
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.api.getUpdates(this.offset, 25);
        if (updates.length === 0) {
          continue;
        }
        for (const update of updates) {
          this.offset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (err) {
        logger.error("Polling error", err);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private async clearOfflineUpdates(): Promise<void> {
    let updates = await this.api.getUpdates(undefined, 0, 100);
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

  private async handleMessage(message: TelegramMessage): Promise<void> {
    if (!message.text && !message.photo && !message.document) return;
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

    if (message.photo || message.document) {
      const handled = await this.handleImages(message, state);
      if (!message.text || !message.text.trim()) {
        if (handled) return;
      }
    }

    if (!message.text || !message.text.trim()) return;

    if (!state.session || !state.workDir) {
      await this.safeSend(chatId, "請先使用 /project 選擇工作區。", message.message_id);
      return;
    }

    if (state.resetting) {
      await this.safeSend(chatId, "工作階段正在重設，請稍後再試。", message.message_id);
      return;
    }

    const policy = await this.guardrailsPromise;
    const promptLimit = policy.maxPromptLength ?? MESSAGE_LIMIT;
    const decision = evaluatePrompt(policy, message.text);
    if (!decision.allowed) {
      await this.safeSend(
        chatId,
        `提示詞被拒絕：${decision.reason ?? "不符合安全規則"} (${decision.ruleId ?? decision.source})`,
        message.message_id
      );
      return;
    }

    const prompt = composePrompt(message.text, state.attachments);
    const combinedDecision = evaluatePromptIgnoringLength(policy, prompt);
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
      await this.safeSend(chatId, `已加入待辦 (${state.pendingTasks.length}/${PENDING_LIMIT})`, message.message_id);
      return;
    }

    state.processing = true;
    state.activePrompt = prompt;
    state.replyToMessageId = message.message_id;
    state.promptCycles += 1;
    state.awaitingReply = true;
    state.completionPending = false;
    state.receivedAssistantMessage = false;
    state.lastAssistantMessageHash = undefined;

    const processing = await this.safeSend(
      chatId,
      `⏳處理中：${prompt.slice(0, 80)}`,
      message.message_id
    );
    state.processingMessageId = processing?.message_id;
    if (state.processingTimer) clearTimeout(state.processingTimer);
    state.processingTimer = setTimeout(() => {
      if (state.processingMessageId) {
        this.api
          .editMessageText({
            chat_id: chatId,
            message_id: state.processingMessageId,
            text: this.prepareOutgoingText(chatId, "⏳處理中…仍在等待 Copilot 回覆"),
            parse_mode: "MarkdownV2"
          })
          .catch((err) => logger.warn("Update processing message failed", err));
      }
    }, 20000);

    logger.info("Prompt sending", { chatId });
    const sendResult = await this.sendPrompt(state, prompt, message.message_id, promptLimit);
    if (sendResult.chunked && sendResult.totalChunks > 1) {
      await this.safeSend(
        chatId,
        `提示詞過長，已拆分為 ${sendResult.totalChunks} 段送出以維持完整內容。`,
        message.message_id
      );
    }
    } catch (err) {
      logger.error("handleMessage error", err);
      await this.safeSend(chatId, "處理訊息時發生錯誤，請稍後再試。", message.message_id);
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
    state.attachments.push({ dataUrl, mime, addedAt: Date.now() });
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

  private async trySendPromptInChunks(
    state: AgentContext,
    prompt: string,
    promptLimit?: number
  ): Promise<number> {
    const limit = promptLimit;
    if (!limit || prompt.length <= limit) return 0;
    const chunks = buildPromptChunks(prompt, limit);
    if (chunks.total <= 1) return 0;
    logger.info("Copilot send chunked", { chatId: state.chatId, total: chunks.total });
    for (const chunk of chunks.chunks) {
      await state.session?.send(chunk);
    }
    return chunks.total;
  }

  private async sendPrompt(
    state: AgentContext,
    prompt: string,
    replyTo?: number,
    promptLimit?: number
  ): Promise<{ chunked: boolean; totalChunks: number }> {
    if (!state.session) return { chunked: false, totalChunks: 0 };
    try {
      logger.info("Copilot send", { chatId: state.chatId });
      await state.session.send(prompt);
      logger.info("Copilot send ok", { chatId: state.chatId });
      return { chunked: false, totalChunks: 1 };
    } catch (err) {
      const isLength = this.isPromptLengthError(err);
      const limit = this.extractPromptLengthLimit(err) ?? promptLimit;
      if (isLength && limit) {
        try {
          const total = await this.trySendPromptInChunks(state, prompt, limit);
          if (total > 0) {
            return { chunked: true, totalChunks: total };
          }
        } catch (chunkErr) {
          logger.warn("Chunked prompt send failed", chunkErr);
        }
      }

      state.processing = false;
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
      case "/start":
      case "/help":
        await this.sendWelcome(undefined, await this.loadAllowedDirectories(), await this.getModels(), message);
        return;
      case "/project":
        await this.sendDirectoryList(chatId);
        return;
      case "/engine":
        await this.handleModelCommand(chatId, args[0]);
        return;
      case "/info":
      case "/i":
        await this.sendStatus(chatId);
        return;
      case "/new":
        await this.resetSession(chatId);
        return;
      case "/imgclear":
        await this.clearImages(chatId);
        return;
      case "/bye":
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

    if (data === "do.project") {
      await this.sendDirectoryList(chatId);
      return;
    }
    if (data === "do.engine") {
      await this.handleModelCommand(chatId, undefined);
      return;
    }
    if (data === "do.info") {
      await this.sendStatus(chatId);
      return;
    }
    if (data === "do.help") {
      await this.sendWelcome(undefined, await this.loadAllowedDirectories(), await this.getModels());
      return;
    }
    if (data === "do.new") {
      await this.resetSession(chatId);
      return;
    }
    if (data === "do.bye") {
      await this.shutdown();
      return;
    }

    if (data.startsWith("pick.proj:")) {
      const index = Number.parseInt(data.split(":")[1] ?? "", 10);
      await this.setDirectory(chatId, index);
      return;
    }
    if (data.startsWith("pick.eng:")) {
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
    if (data.startsWith("tool.confirm:")) {
      const confirmId = data.slice(13);
      const pending = this.pendingToolConfirmations.get(confirmId);
      if (pending) {
        this.pendingToolConfirmations.delete(confirmId);
        pending.resolve(true);
        await this.safeSend(chatId, "✅ 已允許執行。", message?.message_id);
      }
      return;
    }
    if (data.startsWith("tool.deny:")) {
      const confirmId = data.slice(10);
      const pending = this.pendingToolConfirmations.get(confirmId);
      if (pending) {
        this.pendingToolConfirmations.delete(confirmId);
        pending.resolve(false);
        await this.safeSend(chatId, "❌ 已拒絕執行。", message?.message_id);
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

  private async handleModelCommand(chatId: number, arg?: string): Promise<void> {
    const models = await this.getModels();
    if (!models.length) {
      await this.safeSend(chatId, "尚未設定可用引擎。", undefined);
      return;
    }

    const state = this.getOrCreateState(chatId);
    if (!arg) {
      await this.sendModelList(chatId, models, state.engine);
      return;
    }

    const index = parseIndex(arg, models.length);
    if (index < 0 || index >= models.length) {
      await this.safeSend(chatId, "引擎編號無效。", undefined);
      return;
    }

    const selected = models[index];
    if (!selected) {
      await this.safeSend(chatId, "引擎編號無效。", undefined);
      return;
    }
    await this.applyModelChange(chatId, selected);
  }

  private async sendDirectoryList(chatId: number): Promise<void> {
    const dirs = await this.loadAllowedDirectories();
    if (!dirs.length) {
      await this.safeSend(chatId, "沒有可用的工作區。", undefined);
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

    await this.safeSend(chatId, "請選擇工作區：", undefined, keyboard);
  }

  private async sendModelList(chatId: number, models: string[], current?: string): Promise<void> {
    const keyboard: InlineKeyboardMarkup = { inline_keyboard: [] };
    models.forEach((model, index) => {
      if (index % 2 === 0) keyboard.inline_keyboard.push([]);
      const row = keyboard.inline_keyboard[keyboard.inline_keyboard.length - 1]!;
      const label = model === current ? `🟢 ${model}` : model;
      row.push({ text: label, callback_data: `pick.eng:${index}` });
    });

    await this.safeSend(chatId, "請選擇引擎：", undefined, keyboard);
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
    await this.createSession(chatId, selected);
  }

  private async setModel(chatId: number, index: number): Promise<void> {
    const models = await this.getModels();
    if (!models[index]) {
      await this.safeSend(chatId, "引擎索引無效。", undefined);
      return;
    }

    const selected = models[index];
    if (!selected) {
      await this.safeSend(chatId, "引擎索引無效。", undefined);
      return;
    }
    await this.applyModelChange(chatId, selected);
  }

  private async applyModelChange(chatId: number, model: string): Promise<void> {
    const state = this.getOrCreateState(chatId);
    if (state.engine && state.engine !== model) {
      state.starredEngines = [state.engine, ...state.starredEngines.filter((m) => m !== state.engine)].slice(0, 2);
    }
    state.engine = model;

    if (state.workDir) {
      await this.createSession(chatId, state.workDir, model);
    } else {
      await this.safeSend(chatId, "尚未選擇工作區，請先選擇：", undefined);
      await this.sendDirectoryList(chatId);
    }

    await this.safeSend(chatId, `已切換引擎：${model}`, undefined);
  }

  private async sendStatus(chatId: number): Promise<void> {
    const state = this.getOrCreateState(chatId);
    const queuePreview = state.pendingTasks.slice(0, 2).map((t) => t.prompt.slice(0, 40));
    const lines = [
      `👤 擁有者：${this.ownerChatId}`,
      `🔌 連線：${state.session ? "✅ 已連線" : "⬜ 未連線"}`,
      `⚙️ 引擎：${state.engine ?? "未設定"}`,
      `📂 工作區：${state.workDir ?? "未設定"}`,
      `🔄 回合：${state.promptCycles}`,
      `⏳ 處理中：${state.processing ? "是" : "否"}`,
      `📬 待辦：${state.pendingTasks.length} (${queuePreview.join(" / ")})`,
      `🔃 重設中：${state.resetting ? "是" : "否"}`,
      `📝 當前：${state.activePrompt?.slice(0, 100) ?? "無"}`
    ];

    const keyboard: InlineKeyboardMarkup = { inline_keyboard: [] };
    if (state.workDir) {
      keyboard.inline_keyboard.push([
        { text: "🤖 引擎", callback_data: "do.engine" },
        { text: "🔄 重開", callback_data: "do.new" }
      ]);
    } else {
      keyboard.inline_keyboard.push([
        { text: "📁 專案", callback_data: "do.project" },
        { text: "🤖 引擎", callback_data: "do.engine" }
      ]);
    }

    for (const starred of state.starredEngines) {
      const models = await this.getModels();
      const index = models.indexOf(starred);
      if (index >= 0) {
        keyboard.inline_keyboard.push([{ text: `★ ${starred}`, callback_data: `pick.eng:${index}` }]);
      }
    }

    await this.safeSend(chatId, lines.join("\n"), undefined, keyboard);
  }

  private async resetSession(chatId: number): Promise<void> {
    const state = this.getOrCreateState(chatId);
    if (!state.session || !state.workDir || !state.engine) {
      await this.safeSend(chatId, "尚未建立工作階段。", undefined);
      return;
    }

    state.pendingTasks = [];
    state.resetting = true;
    try {
      await state.session.abort();
    } catch (err) {
      if (!isConnectionDisposedError(err)) {
        logger.warn("Abort session failed", err);
      }
    }

    await this.createSession(chatId, state.workDir, state.engine);
    state.resetting = false;
    state.promptCycles = 0;
    await this.safeSend(chatId, "工作階段已重設。", undefined);
  }

  private async clearImages(chatId: number): Promise<void> {
    const state = this.getOrCreateState(chatId);
    state.attachments = [];
    await this.safeSend(chatId, "已清空附件圖片。", undefined);
  }

  private findActiveSessionState(): AgentContext | undefined {
    for (const state of this.states.values()) {
      if (state.session) return state;
    }
    return undefined;
  }

  private async createSession(chatId: number, cwd: string, model?: string): Promise<void> {
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

    const client = new CopilotSdkClient();
    try {
      await client.start();

      const systemPrompt = await buildPersonaPrompt(cwd);

      const models = await this.getModels();
      const useModel = model ?? state.engine ?? getDefaultModel(models);
      if (!useModel) {
        throw new Error("未設定引擎");
      }

      const session = await client.createSession({
        model: useModel,
        workingDirectory: cwd,
        ...(systemPrompt ? { systemPrompt } : {}),
        hooks: {
          onPreToolUse: async (input: any) => {
            const toolName: string | undefined = input?.toolName;
            logger.info("PreToolUse", { tool: toolName });

            if (isWriteOrDeleteTool(toolName)) {
              const confirmId = crypto.randomUUID();
              const argsPreview = JSON.stringify(input?.toolArgs ?? {}).slice(0, TOOL_PREVIEW_LEN);
              const text = `🔧 工具 *${toolName}* 需要確認：\n\`${argsPreview}\``;
              const keyboard: InlineKeyboardMarkup = {
                inline_keyboard: [[
                  { text: "✅ 允許", callback_data: `tool.confirm:${confirmId}` },
                  { text: "❌ 拒絕", callback_data: `tool.deny:${confirmId}` }
                ]]
              };
              await this.safeSend(chatId, text, undefined, keyboard);

              const allowed = await new Promise<boolean>((resolve) => {
                this.pendingToolConfirmations.set(confirmId, { resolve });
                setTimeout(() => {
                  if (this.pendingToolConfirmations.has(confirmId)) {
                    this.pendingToolConfirmations.delete(confirmId);
                    resolve(false);
                  }
                }, TOOL_CONFIRM_TIMEOUT_MS);
              });

              if (!allowed) {
                logger.info("Tool denied by user", { tool: toolName, confirmId });
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
            logger.warn("Copilot error hook", { context: input?.errorContext });
            return { errorHandling: "retry" };
          }
        }
      });

      session.onEvent((event) => this.enqueueEvent(chatId, event));

      state.client = client;
      state.session = session;
      state.workDir = cwd;
      state.engine = useModel;
      state.processing = false;
      state.pendingTasks = [];
      state.resetting = false;
      state.activePrompt = undefined;
      state.awaitingReply = false;
      state.completionPending = false;
      state.pendingEvents = [];
      state.dispatchingEvents = false;
      state.toolMessageMap.clear();
      state.personaLoaded = true;
      if (state.processingTimer) {
        clearTimeout(state.processingTimer);
        state.processingTimer = undefined;
      }

      await this.safeSend(chatId, `已建立工作階段：${path.basename(cwd)}`, undefined);
      await this.sendContextSummary(chatId, state);
    } catch (err) {
      await client.stop().catch((stopErr) => {
        if (!isConnectionDisposedError(stopErr)) logger.warn("Stop client failed", stopErr);
      });
      await this.safeSend(chatId, `建立工作階段失敗：${String(err)}`, undefined);
    }
  }

  private async enqueueEvent(chatId: number, event: CopilotEvent): Promise<void> {
    const state = this.getOrCreateState(chatId);
    const type = event.type ?? (event as { event?: string }).event ?? "unknown";
    logger.info("Copilot event", { chatId, type });
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

  private async handleEvent(chatId: number, event: CopilotEvent): Promise<void> {
    const state = this.getOrCreateState(chatId);
    const type = event.type ?? (event as { event?: string }).event;
    const data = event.data ?? event;

    switch (type) {
      case "assistant.message": {
        const content = this.extractText(data);
        if (content) {
          const hash = this.hashText(content);
          if (state.lastAssistantMessageHash === hash) {
            return;
          }
          state.lastAssistantMessageHash = hash;
          if (state.processingMessageId && content.length <= 3500) {
            await this.editMessageSafe(chatId, state.processingMessageId, content);
            state.processingMessageId = undefined;
          } else {
            await this.sendAssistantMessage(chatId, content, state.replyToMessageId);
            if (state.processingMessageId) {
              await this.editMessageSafe(chatId, state.processingMessageId, "✅完成");
              state.processingMessageId = undefined;
            }
          }
          state.awaitingReply = false;
          state.receivedAssistantMessage = true;
          if (state.processingTimer) {
            clearTimeout(state.processingTimer);
            state.processingTimer = undefined;
          }
          if (state.completionPending && state.pendingTasks.length === 0) {
            state.completionPending = false;
            await this.sendDoneNotice(chatId, state);
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
        state.activePrompt = undefined;
        if (state.processingTimer) {
          clearTimeout(state.processingTimer);
          state.processingTimer = undefined;
        }
        if (state.pendingTasks.length === 0) {
          if (state.awaitingReply) {
            state.completionPending = true;
          } else if (!state.receivedAssistantMessage) {
            await this.sendDoneNotice(chatId, { ...state, activePrompt: completedPrompt });
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
        const processing = await this.safeSend(chatId, `⏳處理中：${nextPrompt.slice(0, 80)}`, state.replyToMessageId);
        state.processingMessageId = processing?.message_id;
        const policy = await this.guardrailsPromise;
        const promptLimit = policy.maxPromptLength ?? MESSAGE_LIMIT;
        const sendResult = await this.sendPrompt(state, nextPrompt, state.replyToMessageId, promptLimit);
        if (sendResult.chunked && sendResult.totalChunks > 1) {
          await this.safeSend(
            chatId,
            `提示詞過長，已拆分為 ${sendResult.totalChunks} 段送出以維持完整內容。`,
            state.replyToMessageId
          );
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

  private async handleToolStart(chatId: number, state: AgentContext, payload: unknown): Promise<void> {
    const record = payload as Record<string, unknown>;
    const name = this.extractString(record, ["toolName", "name", "tool", "functionName"]);
    const callId = this.extractString(record, ["toolCallId", "callId", "id", "tool_call_id", "parentId"]);
    const args = record.args ?? record.arguments ?? record.params ?? record.input;
    const argsText = args ? formatJsonResult(args) ?? String(args) : "";

    const paramsKey = this.createResultKey(chatId);
    const resultKey = this.createResultKey(chatId);
    const summary = redact((argsText ?? "").slice(0, TOOL_PREVIEW_LEN));

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
      `工具執行中：${name ?? "未知"}\n參數摘要：${summary}`,
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

  private async sendAssistantMessage(chatId: number, text: string, replyTo?: number): Promise<void> {
    if (!text.trim()) {
      logger.warn("Assistant message empty", { chatId });
      return;
    }
    await this.safeSend(chatId, text, replyTo);
  }

  private async sendDoneNotice(chatId: number, state: AgentContext): Promise<void> {
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

  private prepareOutgoingRaw(chatId: number, text: string): string {
    const state = this.getOrCreateState(chatId);
    const trimmed = text.trimStart();
    const iconPool = getIconPool();
    const hasPoolHeader = iconPool.some((icon) => trimmed.startsWith(icon));
    const hasEmojiHeader = /^\p{Extended_Pictographic}/u.test(trimmed);
    const hasHeader = hasPoolHeader || hasEmojiHeader;
    const header = `${state.sessionIcon} Copilot · ${state.workDir ? path.basename(state.workDir) : "未選擇"}`;
    const withHeader = hasHeader ? text : `${header}\n${text}`;
    return redact(withHeader);
  }

  private prepareOutgoingText(chatId: number, text: string): string {
    return markdownToTelegram(this.prepareOutgoingRaw(chatId, text));
  }

  private async safeSend(
    chatId: number,
    text: string,
    replyTo?: number,
    keyboard?: InlineKeyboardMarkup
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
        disable_web_page_preview: true
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
            disable_web_page_preview: true
          });
        } catch (err) {
          logger.error("Send message failed", err);
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
      logger.warn("Edit message plain failed, fallback to send", err);
      await this.safeSend(chatId, text, undefined, keyboard);
    }
  }

  private getOrCreateState(chatId: number): AgentContext {
    const existing = this.states.get(chatId);
    if (existing) return existing;

    const used = new Set(Array.from(this.states.values()).map((state) => state.sessionIcon));
    const icon = pickIcon(used);

    const state: AgentContext = {
      chatId,
      client: undefined,
      session: undefined,
      workDir: undefined,
      engine: undefined,
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
      promptCycles: 0,
      starredEngines: [],
      cachedDirs: [],
      personaLoaded: false,
      reactionEmojis: null
    };

    this.states.set(chatId, state);
    return state;
  }

  private async loadAllowedDirectories(): Promise<string[]> {
    const secrets = await loadSecrets();
    const patterns = await loadDirectoryPatterns(secrets.directoryPatterns);
    return expandDirectoryPatterns(patterns);
  }

  private async getModels(): Promise<string[]> {
    const now = Date.now();
    if (this.modelsCache && now - this.modelsCache.fetchedAt < this.modelsTtlMs) {
      return this.modelsCache.models;
    }
    const models = await loadSupportedModels();
    this.modelsCache = { models, fetchedAt: now };
    return models;
  }

  private async findSkillsPath(cwd: string): Promise<string | undefined> {
    const candidate = path.join(cwd, ".github", "skills");
    try {
      const stat = await (await import("node:fs/promises")).stat(candidate);
      return stat.isDirectory() ? candidate : undefined;
    } catch {
      return undefined;
    }
  }

  private createResultKey(chatId: number): string {
    const rand = crypto.randomBytes(6).toString("hex");
    return `${Date.now().toString(36)}${rand}`;
  }

  private hashText(text: string): string {
    return crypto.createHash("sha1").update(text).digest("hex");
  }

  private async fetchProviderInfo(): Promise<string | undefined> {
    try {
      const client = new CopilotSdkClient();
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

  private async sendWelcome(providerInfo: string | undefined, dirs: string[], models: string[], message?: TelegramMessage): Promise<void> {
    const chatId = Number(this.ownerChatId);
    const nowText = this.formatServerTime();
    const ownerName = await this.fetchOwnerName();
    const state = this.getOrCreateState(chatId);
    const currentDir = state.workDir ? path.basename(state.workDir) : "未選擇";
    const currentModel = state.engine ?? getDefaultModel(models) ?? "未設定";
    const text = [
      "💎 TeleTopaz — AI 遠端助理",
      "",
      `🕐 ${nowText}`,
      `👤 ${ownerName}`,
      `📂 ${currentDir}`,
      `⚙️ ${currentModel}`,
      "",
      "📌 指令：",
      "/project — 選擇工作區",
      "/engine — 切換 AI 引擎",
      "/info — 檢視狀態",
      "/new — 重啟對話",
      "/imgclear — 清除附件",
      "/bye — 關閉",
      "/help — 說明",
      "",
      providerInfo ?? "⚙️ 無可用引擎"
    ].join("\n");

    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: "📁 專案", callback_data: "do.project" },
          { text: "🤖 引擎", callback_data: "do.engine" }
        ],
        [
          { text: "📊 狀態", callback_data: "do.info" },
          { text: "🔄 重開", callback_data: "do.new" }
        ]
      ]
    };

    await this.safeSend(chatId, text.trim(), message?.message_id, keyboard);
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
    const lines: string[] = [`⚙️ 可用引擎（共 ${total} 個）`];
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

  private async sendContextSummary(chatId: number, state: AgentContext): Promise<void> {
    const currentDir = state.workDir ? path.basename(state.workDir) : "未選擇";
    const models = await this.getModels();
    const currentModel = state.engine ?? getDefaultModel(models) ?? "未設定";
    await this.safeSend(chatId, `📁目前專案：${currentDir}\n⚙️目前引擎：${currentModel}`, undefined);
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.running = false;
    const tasks: Promise<void>[] = [];

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
