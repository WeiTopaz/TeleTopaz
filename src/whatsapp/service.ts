/**
 * WhatsApp channel for TeleTopaz.
 *
 * 環境變數：
 *   TELETOPAZ_WA_OWNER_JIDS  – 逗號分隔的擁有者電話/JID（必填，否則此頻道不啟動）
 *                               範例: "886912345678,886987654321"
 *                               或完整 JID: "886912345678@s.whatsapp.net"
 *   TELETOPAZ_WA_AUTH_DIR    – 認證資料目錄（預設: ~/.teletopaz/whatsapp-auth）
 *   TELETOPAZ_WA_MODEL       – 預設模型（同 TELETOPAZ_DEFAULT_MODEL 格式，如 cccli:claude-sonnet-4.6）
 *
 * 所有工具操作預設自動核准（擁有者身份已透過手機掃碼驗證）。
 * 可透過 /allowall 指令切換手動確認模式（WhatsApp 版僅記錄，無互動按鈕）。
 */

import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { WhatsAppClient, type WaMessage, type WaMessageKey } from "./client.js";
import { markdownToWhatsApp, splitLongMessage } from "./markdown.js";
import { createProviderClient } from "../provider/factory.js";
import type { WaAttachment, WaPendingTask, WaRecovery, WaToolTracking, WaState } from "./types.js";
import { SessionMemoryStore } from "../session/memory-store.js";
import { buildPersonaPrompt } from "../session/persona.js";
import { loadConfiguredRuntimeConfig, loadWaOwnerJids } from "../config/secrets.js";
import { loadDirectoryPatterns, expandDirectoryPatterns } from "../config/directories.js";
import { DEFAULT_MODEL_ENTRY, parseModelEntry } from "../config/models.js";
import { logger } from "../util/logger.js";
import { redact } from "../util/redaction.js";
import {
  loadGuardrails,
  evaluatePrompt,
  evaluatePromptWithOptions,
  guardToolOutput,
} from "../guardrails/guardrails.js";
import type { GuardrailPolicy } from "../guardrails/types.js";
import type { AiAttachment, AiClient, AiEvent, AiSession, ProviderType } from "../provider/types.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_PENDING = 15;
const MAX_ATTACHMENTS = 8;
const MSG_LIMIT = 4000;
const TOOL_PREVIEW_LEN = 300;
const SESSION_IDLE_REBUILD_MS = 60 * 60 * 1000;      // 1 hour
const SESSION_MAX_LIFETIME_MS = 10 * 60 * 60 * 1000; // 10 hours
const CLASSIFIER_TIMEOUT_MS = 30_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export type { WaAttachment, WaPendingTask, WaState } from "./types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveApprovalMode(p: ProviderType): "plan" | "auto_edit" | undefined {
  if (p === "gemini") return "plan";
  if (p === "claude-code") return "auto_edit";
  return undefined;
}

/** Stable numeric hash of a JID string, used as chatId for SessionMemoryStore. */
function jidToId(jid: string): number {
  let h = 0;
  for (const c of jid) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

function extractText(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d["content"] === "string") return d["content"];
  if (Array.isArray(d["content"])) {
    return (d["content"] as Array<Record<string, unknown>>)
      .filter((c) => c["type"] === "text")
      .map((c) => String(c["text"] ?? ""))
      .join("");
  }
  if (typeof d["text"] === "string") return d["text"];
  if (typeof d["message"] === "string") return d["message"];
  if (d["message"] && typeof d["message"] === "object") {
    const m = d["message"] as Record<string, unknown>;
    if (typeof m["content"] === "string") return m["content"];
  }
  return null;
}

function extractString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = record[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

function formatJsonResult(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class WhatsAppService {
  private wa: WhatsAppClient;
  private ownerPhones: Set<string>;
  private sessions = new Map<string, WaState>();
  private sessionMemory = new SessionMemoryStore();
  private defaultModel: string;
  private defaultProvider: ProviderType;
  private defaultWorkDir: string | undefined;
  private guardrailsPromise: Promise<GuardrailPolicy>;

  private constructor(opts: {
    ownerJids: string[];
    authDir: string;
    defaultModel: string;
    defaultProvider: ProviderType;
    defaultWorkDir: string | undefined;
  }) {
    // Accept both bare phone "886912345678" and full JID "886912345678@s.whatsapp.net"
    this.ownerPhones = new Set(opts.ownerJids.map((j) => j.split("@")[0] ?? j));
    this.defaultModel = opts.defaultModel;
    this.defaultProvider = opts.defaultProvider;
    this.defaultWorkDir = opts.defaultWorkDir;
    this.guardrailsPromise = loadGuardrails();
    this.wa = new WhatsAppClient({
      authDir: opts.authDir,
      onMessage: (msg) => void this.handleMessage(msg),
      onStatus: (s) => logger.info("WhatsApp status", { status: s }),
    });
  }

  /**
   * Returns null if TELETOPAZ_WA_OWNER_JIDS is not set (WhatsApp disabled).
   */
  static async create(): Promise<WhatsAppService | null> {
    const raw =
      process.env["TELETOPAZ_WA_OWNER_JIDS"] ??
      (await loadWaOwnerJids().catch(() => undefined));
    if (!raw?.trim()) return null;

    const ownerJids = raw.split(",").map((j) => j.trim()).filter(Boolean);
    if (!ownerJids.length) return null;

    const authDir =
      process.env["TELETOPAZ_WA_AUTH_DIR"] ??
      path.join(os.homedir(), ".teletopaz", "whatsapp-auth");
    await fs.mkdir(authDir, { recursive: true });

    const entry =
      process.env["TELETOPAZ_WA_MODEL"] ??
      process.env["TELETOPAZ_DEFAULT_MODEL"] ??
      DEFAULT_MODEL_ENTRY;
    const { model: defaultModel, provider: defaultProvider } = parseModelEntry(entry);

    const runtimeConfig = await loadConfiguredRuntimeConfig().catch(() => undefined);
    let defaultWorkDir: string | undefined;
    if (runtimeConfig?.directoryPatterns) {
      const patterns = await loadDirectoryPatterns(runtimeConfig.directoryPatterns);
      const dirs = await expandDirectoryPatterns(patterns);
      defaultWorkDir = dirs.find((d) => path.basename(d) === "TempNote") ?? dirs[0];
    }

    return new WhatsAppService({ ownerJids, authDir, defaultModel, defaultProvider, defaultWorkDir });
  }

  async start(): Promise<void> {
    logger.info("WhatsApp service starting");
    await this.wa.connect();
  }

  async stop(): Promise<void> {
    for (const state of this.sessions.values()) {
      await state.session?.destroy().catch(() => undefined);
      await state.client?.stop().catch(() => undefined);
    }
    this.sessions.clear();
    await this.wa.disconnect();
  }

  // ─── Message routing ──────────────────────────────────────────────────────

  private isOwner(jid: string): boolean {
    // Self-chat via LID: client.ts already verified fromMe=true, so trust @lid JIDs.
    if (jid.endsWith("@lid")) return true;
    const phone = jid.split("@")[0] ?? jid;
    return this.ownerPhones.has(phone) || this.ownerPhones.has(jid);
  }

  private async handleMessage(msg: WaMessage): Promise<void> {
    // For groups, verify the sender (participant) is an owner.
    const senderJid = msg.isGroup ? (msg.participant ?? "") : msg.from;
    if (!this.isOwner(senderJid)) return;

    // Mark the message as read so the sender sees the bot has received it.
    await this.wa.markAsRead(msg.from, msg.messageKey).catch(() => undefined);

    logger.info("WA message received", {
      from: msg.from,
      sender: senderJid,
      isGroup: msg.isGroup,
      content: msg.content.slice(0, 50),
    });

    const text = msg.content.trim();

    // Commands take priority
    if (text.startsWith("/")) {
      await this.handleCommand(msg.from, text, msg);
      return;
    }

    // Accumulate media attachments
    const attachments: WaAttachment[] = [];
    if (msg.mediaItems) {
      for (const item of msg.mediaItems) {
        if (attachments.length >= MAX_ATTACHMENTS) break;
        attachments.push({ filePath: item.path, mime: item.mime });
      }
    }

    if (!text && attachments.length === 0) return;

    // Guardrails: only validate text prompts (not empty text with media only)
    if (text) {
      const policy = await this.guardrailsPromise;
      const decision = evaluatePrompt(policy, text);
      if (!decision.allowed) {
        await this.send(msg.from, `❌ 提示詞被拒絕：${decision.reason ?? "不符合安全規則"} (${decision.ruleId ?? decision.source})`);
        return;
      }
    }

    const state = this.getOrCreateState(msg.from);

    if (state.processing) {
      if (state.pendingTasks.length >= MAX_PENDING) {
        await this.send(msg.from, "⚠️ 待辦已滿，請稍後再試。");
        return;
      }
      const task: WaPendingTask = { prompt: text, attachments, queuedAt: Date.now() };
      state.pendingTasks.push(task);
      await this.send(msg.from, `⏳ 已排隊 (${state.pendingTasks.length}/${MAX_PENDING})`);
      return;
    }

    await this.processPrompt(msg.from, { prompt: text, attachments, queuedAt: Date.now() });
  }

  // ─── Commands ─────────────────────────────────────────────────────────────

  private async handleCommand(jid: string, text: string, _msg: WaMessage): Promise<void> {
    const parts = text.split(/\s+/);
    const cmd = parts[0]!;
    const arg = parts.slice(1).join(" ");
    const arg1 = parts[1];

    switch (cmd) {
      case "/help":
        await this.send(
          jid,
          [
            "📖 *TeleTopaz WhatsApp 指令說明*",
            "",
            "/help        顯示此說明",
            "/info        顯示目前狀態",
            "/model [入口]  查詢或切換模型",
            "/model auto   啟用 Auto Mode（自動路由）",
            "/project     列出或切換工作專案",
            "/clear       清除對話記錄",
            "/silent      切換靜默模式（工具通知合併）",
            "/allowall    切換工具自動批准",
            "/router <問題>  使用 Router 模型單次查詢",
            "/newproject <名稱>  建立新專案",
            "/quit        關閉 WhatsApp 服務",
          ].join("\n"),
        );
        return;

      case "/model": {
        const state = this.sessions.get(jid);
        if (!arg1) {
          const modeStr = state?.mode === "auto"
            ? `Auto (router: ${state.routerModel ?? "未設定"} / core: ${state.coreModel ?? "未設定"})`
            : state?.model ?? this.defaultModel;
          await this.send(jid, `目前模型：${modeStr}`);
          return;
        }
        if (arg1 === "auto") {
          if (!arg || arg === "auto") {
            await this.send(jid, "ℹ️ 請先設定 router/core 模型：\n/model config_router <入口>\n/model config_core <入口>");
            return;
          }
        }
        if (arg1 === "config_router") {
          const s = this.getOrCreateState(jid);
          s.routerModel = parts[2];
          s.mode = "auto";
          await this.send(jid, `✅ Router 模型設為 ${parts[2]}`);
          return;
        }
        if (arg1 === "config_core") {
          const s = this.getOrCreateState(jid);
          s.coreModel = parts[2];
          s.mode = "auto";
          await this.send(jid, `✅ Core 模型設為 ${parts[2]}`);
          return;
        }
        // Switch to manual model
        const parsed = parseModelEntry(arg1);
        if (state) {
          await this.clearSession(jid);
          state.model = parsed.model;
          state.provider = parsed.provider;
          state.mode = "manual";
        } else {
          const s = this.newState(parsed.model, parsed.provider);
          this.sessions.set(jid, s);
        }
        await this.send(jid, `✅ 模型已切換至 ${arg1}`);
        return;
      }

      case "/project": {
        const dirs = await this.loadDirs();
        if (!dirs.length) {
          await this.send(jid, "沒有可用的專案");
          return;
        }
        if (arg1) {
          const idx = parseInt(arg1, 10) - 1;
          const dir = dirs[idx];
          if (!dir) { await this.send(jid, "索引無效"); return; }
          await this.clearSession(jid);
          const prev = this.sessions.get(jid) ?? this.newState(this.defaultModel, this.defaultProvider);
          prev.workDir = dir;
          this.sessions.set(jid, prev);
          await this.send(jid, `✅ 已切換至 ${path.basename(dir)}`);
        } else {
          const list = dirs.map((d, i) => `${i + 1}. ${path.basename(d)}`).join("\n");
          await this.send(jid, `可用專案：\n${list}\n\n/project <編號> 切換`);
        }
        return;
      }

      case "/clear":
        await this.clearSession(jid);
        await this.send(jid, "✅ 已清除對話");
        return;

      case "/info": {
        const state = this.sessions.get(jid);
        const modeStr = state?.mode === "auto"
          ? `Auto (router: ${state.routerModel ?? "?"} / core: ${state.coreModel ?? "?"})`
          : state?.model ?? this.defaultModel;
        const info = state
          ? [
              `📂 ${path.basename(state.workDir)}`,
              `🤖 ${modeStr}`,
              `🔌 ${state.session ? "已連線" : "未連線"}`,
              `🔢 本次對話：${state.promptCycles} 次`,
              `🔇 靜默模式：${state.silentMode ? "開啟" : "關閉"}`,
              `🛡️ 自動批准：${state.allowAll ? "開啟" : "關閉"}`,
            ].join("\n")
          : `🤖 ${this.defaultModel}\n🔌 未初始化`;
        await this.send(jid, info);
        return;
      }

      case "/silent": {
        const state = this.getOrCreateState(jid);
        state.silentMode = !state.silentMode;
        await this.send(jid, `🔇 靜默模式：${state.silentMode ? "已開啟" : "已關閉"}`);
        return;
      }

      case "/allowall": {
        const state = this.getOrCreateState(jid);
        state.allowAll = !state.allowAll;
        await this.send(jid, `🛡️ 工具自動批准：${state.allowAll ? "已開啟" : "已關閉"}`);
        return;
      }

      case "/router": {
        const prompt = arg.trim();
        if (!prompt) { await this.send(jid, "用法：/router <問題>"); return; }
        const state = this.getOrCreateState(jid);
        const routerModel = state.routerModel ?? state.model;
        if (state.processing) {
          await this.send(jid, "⚠️ 正在處理中，請稍後再試");
          return;
        }
        await this.processPrompt(jid, { prompt, attachments: [], queuedAt: Date.now() }, routerModel);
        return;
      }

      case "/newproject": {
        const name = arg.trim();
        if (!name) { await this.send(jid, "用法：/newproject <名稱>"); return; }
        const dirs = await this.loadDirs();
        const baseDir = dirs[0] ? path.dirname(dirs[0]) : (this.defaultWorkDir ? path.dirname(this.defaultWorkDir) : os.homedir());
        const newDir = path.join(baseDir, name);
        try {
          await fs.mkdir(newDir, { recursive: true });
          await this.clearSession(jid);
          const state = this.getOrCreateState(jid);
          state.workDir = newDir;
          await this.send(jid, `✅ 已建立並切換至 ${name}`);
        } catch (err) {
          await this.send(jid, `❌ 建立失敗：${String(err)}`);
        }
        return;
      }

      case "/quit":
        await this.send(jid, "👋 WhatsApp 服務關閉中…");
        await this.stop();
        process.exit(0);
        return;

      default:
        await this.send(jid, `未知命令：${cmd}\n輸入 /help 查看可用指令`);
    }
  }

  // ─── Session management ───────────────────────────────────────────────────

  private getOrCreateState(jid: string): WaState {
    let state = this.sessions.get(jid);
    if (!state) {
      state = this.newState(this.defaultModel, this.defaultProvider);
      this.sessions.set(jid, state);
    }
    return state;
  }

  private newState(model: string, provider: ProviderType): WaState {
    return {
      client: undefined,
      session: undefined,
      workDir: this.defaultWorkDir ?? "",
      model,
      provider,
      mode: "manual",
      routerModel: undefined,
      coreModel: undefined,
      processing: false,
      pendingTasks: [],
      lastPrompt: undefined,
      lastReply: undefined,
      sessionCreatedAt: undefined,
      sessionLastActivityAt: undefined,
      pendingRecovery: undefined,
      promptCycles: 0,
      allowAll: false,
      silentMode: false,
      toolMessageMap: new Map(),
      currentAttachments: [],
    };
  }

  private async loadDirs(): Promise<string[]> {
    const cfg = await loadConfiguredRuntimeConfig().catch(() => undefined);
    if (!cfg?.directoryPatterns) return [];
    const patterns = await loadDirectoryPatterns(cfg.directoryPatterns);
    return expandDirectoryPatterns(patterns);
  }

  private async clearSession(jid: string): Promise<void> {
    const state = this.sessions.get(jid);
    if (!state) return;
    await state.session?.destroy().catch(() => undefined);
    await state.client?.stop().catch(() => undefined);
    state.client = undefined;
    state.session = undefined;
    state.processing = false;
    state.pendingTasks = [];
    state.lastPrompt = undefined;
    state.lastReply = undefined;
    state.sessionCreatedAt = undefined;
    state.sessionLastActivityAt = undefined;
    state.pendingRecovery = undefined;
    state.currentAttachments = [];
    state.toolMessageMap.clear();
  }

  private checkSessionExpiry(state: WaState): "fresh" | "idle" | "expired" {
    if (!state.session || !state.sessionCreatedAt) return "fresh";
    const now = Date.now();
    if (now - state.sessionCreatedAt >= SESSION_MAX_LIFETIME_MS) return "expired";
    if (state.sessionLastActivityAt && now - state.sessionLastActivityAt >= SESSION_IDLE_REBUILD_MS) return "idle";
    return "fresh";
  }

  // ─── AI session ───────────────────────────────────────────────────────────

  private async ensureSession(jid: string, state: WaState): Promise<boolean> {
    if (state.session) return true;

    if (!state.workDir) {
      await this.send(jid, "❌ 請先 /project 設定工作目錄");
      return false;
    }

    const client = createProviderClient(state.provider);
    try {
      await client.start();
      const cwd = await fs.realpath(state.workDir).catch(() => path.resolve(state.workDir));
      const chatId = jidToId(jid);
      const memCtx = await this.sessionMemory.buildContext({ chatId, workDir: cwd }).catch(() => undefined);
      const systemPrompt = await buildPersonaPrompt(cwd, state.provider, memCtx);
      const approvalMode = resolveApprovalMode(state.provider);

      const session = await client.createSession({
        model: state.model,
        workingDirectory: cwd,
        ...(approvalMode ? { approvalMode } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
        onPermissionRequest: async () => ({ kind: "approved" as const }),
        hooks: {
          onPreToolUse: async (input: unknown) => {
            logger.info("WA tool", { tool: (input as Record<string, unknown>)?.["toolName"] });
            return { permissionDecision: "allow", modifiedArgs: (input as Record<string, unknown>)?.["toolArgs"] };
          },
          onPostToolUse: async () => ({}),
          onErrorOccurred: async () => ({ errorHandling: "retry" }),
        },
      });

      state.client = client;
      state.session = session;
      state.sessionCreatedAt = Date.now();
      state.sessionLastActivityAt = Date.now();
      session.onEvent((event: AiEvent) => void this.handleAiEvent(jid, event));
      return true;
    } catch (err) {
      await client.stop().catch(() => undefined);
      await this.send(jid, `❌ 建立工作階段失敗：${String(err)}`);
      return false;
    }
  }

  private async processPrompt(jid: string, task: WaPendingTask, overrideModel?: string): Promise<void> {
    const state = this.getOrCreateState(jid);

    // Session lifecycle: rebuild if expired or idle
    const expiry = this.checkSessionExpiry(state);
    if (expiry !== "fresh") {
      const reason = expiry === "expired" ? "已達最大存活時間" : "閒置超時";
      logger.info(`WA session ${expiry}, rebuilding`, { jid, reason });
      await this.clearSession(jid);
      await this.send(jid, `♻️ 工作階段${reason}，自動重建中…`);
    }

    // If model override, switch model temporarily
    if (overrideModel && overrideModel !== state.model) {
      const parsed = parseModelEntry(overrideModel);
      if (!state.session) {
        state.model = parsed.model;
        state.provider = parsed.provider;
      }
    }

    const ok = await this.ensureSession(jid, state);
    if (!ok) return;

    // Convert attachments to AiAttachments
    const aiAttachments: AiAttachment[] = task.attachments
      .filter((a) => a.filePath)
      .map((a) => ({ type: a.mime, path: a.filePath, displayName: path.basename(a.filePath) }));

    state.processing = true;
    state.lastPrompt = task.prompt || undefined;
    state.lastReply = undefined;
    state.promptCycles += 1;

    // Validate combined prompt against guardrails (ignoring length, skipping semantic on attachments)
    if (task.attachments.length > 0 && task.prompt) {
      const policy = await this.guardrailsPromise;
      const combinedDecision = evaluatePromptWithOptions(policy, task.prompt, { ignoreLength: true, skipSemantic: true });
      if (!combinedDecision.allowed) {
        state.processing = false;
        await this.send(jid, `❌ 提示詞被拒絕：${combinedDecision.reason ?? "不符合安全規則"}`);
        return;
      }
    }

    // Send typing indicator
    await this.wa.sendPresenceUpdate(jid, "composing").catch(() => undefined);

    await this.send(jid, `⏳ 處理中：${task.prompt ? task.prompt.slice(0, 80) : "(媒體附件)"}${task.prompt && task.prompt.length > 80 ? "…" : ""}`);

    await state.session!.send(task.prompt || "", aiAttachments.length > 0 ? aiAttachments : undefined).catch(async (err: unknown) => {
      if (state) state.processing = false;
      state.pendingRecovery = { prompt: task.prompt, attachments: task.attachments };
      await this.wa.sendPresenceUpdate(jid, "available").catch(() => undefined);
      await this.send(jid, `❌ 送出失敗：${String(err)}\n💡 工作階段已儲存，輸入任意訊息將自動恢復`);
    });
  }

  // ─── Auto Mode ────────────────────────────────────────────────────────────

  private async classifyIntent(jid: string, text: string, routerModel: string): Promise<"ROUTER" | "CORE"> {
    const { provider } = parseModelEntry(routerModel);
    const client = createProviderClient(provider);
    try {
      await client.start();
      const session = await client.createSession({
        model: routerModel,
        approvalMode: "plan",
        workingDirectory: process.cwd(),
        systemPrompt:
          "You are an intent classifier. Determine if the user's request is simple (greetings, quick queries, simple docs, web search, casual chat) or complex (coding, reasoning, summarization, long writing, analysis, planning). Never call tools. Return 'ROUTER' for simple and 'CORE' for complex. Return ONLY the label.",
        onPermissionRequest: async () => ({ kind: "denied-by-rules" as const, rules: [] }),
        hooks: {
          onPreToolUse: async () => ({ permissionDecision: "deny" }),
        },
      });

      let classification = "CORE";
      session.onEvent((event: AiEvent) => {
        if (event.type === "assistant.message") {
          const content = extractText(event.data);
          if (content) {
            const upper = content.trim().toUpperCase();
            if (upper.includes("ROUTER")) classification = "ROUTER";
            else if (upper.includes("CORE")) classification = "CORE";
          }
        }
      });

      await session.send(text);
      await new Promise((resolve) => setTimeout(resolve, CLASSIFIER_TIMEOUT_MS));
      await session.destroy();

      logger.info("WA intent classified", { jid, classification });
      return classification as "ROUTER" | "CORE";
    } catch (err) {
      logger.warn("WA classification failed, defaulting to CORE", { jid, err: String(err) });
      return "CORE";
    } finally {
      await client.stop().catch(() => undefined);
    }
  }

  // ─── AI event handling ────────────────────────────────────────────────────

  private async handleAiEvent(jid: string, event: AiEvent): Promise<void> {
    const state = this.sessions.get(jid);
    if (!state) return;

    const type = event.type ?? (event as { event?: string }).event;
    const data = event.data ?? event;

    // Update session activity timestamp
    if (type && state.session) {
      state.sessionLastActivityAt = Date.now();
    }

    switch (type) {
      case "assistant.message": {
        const content = extractText(data);
        if (content) {
          state.lastReply = content;
          const formatted = markdownToWhatsApp(redact(content));
          for (const chunk of splitLongMessage(formatted, MSG_LIMIT)) {
            await this.send(jid, chunk);
          }
          // Stop typing indicator after first reply
          await this.wa.sendPresenceUpdate(jid, "available").catch(() => undefined);
        }
        return;
      }

      case "assistant.message_delta":
        // Ignore delta to avoid duplicate replies
        return;

      case "tool.execution_start":
        await this.handleToolStart(jid, state, data);
        return;

      case "tool.execution_complete":
        await this.handleToolComplete(jid, state, data);
        return;

      case "session.idle": {
        state.processing = false;
        const completedPrompt = state.lastPrompt;
        const completedReply = state.lastReply;
        state.lastPrompt = undefined;
        state.lastReply = undefined;

        // Stop typing indicator
        await this.wa.sendPresenceUpdate(jid, "available").catch(() => undefined);

        // Persist to session memory
        if (completedPrompt || completedReply) {
          const chatId = jidToId(jid);
          if (completedPrompt) {
            await this.sessionMemory.append({ chatId, workDir: state.workDir }, "user", completedPrompt).catch(() => undefined);
          }
          if (completedReply) {
            await this.sessionMemory.append({ chatId, workDir: state.workDir }, "assistant", completedReply).catch(() => undefined);
          }
        }

        // Process next pending task
        const next = state.pendingTasks.shift();
        if (next) {
          void this.processPrompt(jid, next);
        }
        return;
      }

      default:
        return;
    }
  }

  private async handleToolStart(jid: string, state: WaState, payload: unknown): Promise<void> {
    const record = payload as Record<string, unknown>;
    const name = extractString(record, ["toolName", "name", "tool", "functionName"]) ?? "未知";
    const callId = extractString(record, ["toolCallId", "callId", "id", "tool_call_id", "parentId"]);
    const args = record["args"] ?? record["arguments"] ?? record["params"] ?? record["input"];
    const argsText = args ? formatJsonResult(args) ?? String(args) : "";
    const summary = redact(argsText.slice(0, TOOL_PREVIEW_LEN));

    const toolMsg = state.silentMode
      ? `🔧 ${name}…`
      : `🔧 工具執行中：*${name}*\n參數：${summary || "(無)"}`;

    const msgKey = await this.send(jid, toolMsg);

    if (callId) {
      const tracking: WaToolTracking = {
        toolName: name,
        callId,
        msgKey: msgKey ?? undefined,
        startTime: Date.now(),
      };
      state.toolMessageMap.set(callId, tracking);
    }
  }

  private async handleToolComplete(jid: string, state: WaState, payload: unknown): Promise<void> {
    const record = payload as Record<string, unknown>;
    const callId = extractString(record, ["toolCallId", "callId", "id", "tool_call_id", "parentId"]);
    const tracking = callId ? state.toolMessageMap.get(callId) : undefined;

    const result = record["result"] ?? record["output"] ?? record["response"] ?? record["data"];
    const error = record["error"] ?? record["err"];
    const resultText = formatJsonResult(result ?? error) ?? "";

    const policy = await this.guardrailsPromise;
    const guarded = guardToolOutput(policy, resultText);
    const summary = redact(guarded.text.slice(0, TOOL_PREVIEW_LEN));
    const isError = Boolean(error);
    const statusEmoji = isError ? "❌" : "✅";

    if (!state.silentMode && tracking?.msgKey) {
      // React to the tool start message with status emoji
      await this.wa.sendReaction(jid, tracking.msgKey, statusEmoji).catch(() => undefined);
    }

    if (tracking && !state.silentMode) {
      const completeMsg = `${statusEmoji} 工具${isError ? "失敗" : "完成"}：${tracking.toolName}\n結果：${summary || "(空)"}`;
      await this.send(jid, completeMsg);
    }

    if (callId) state.toolMessageMap.delete(callId);
  }

  // ─── Sending ──────────────────────────────────────────────────────────────

  private async send(jid: string, text: string): Promise<WaMessageKey | null> {
    logger.info("WA sending", { jid, text: text.slice(0, 80) });
    return this.wa.sendMessage(jid, text).catch((err: unknown) => {
      logger.error("WA send failed", { jid, err: String(err) });
      return null;
    });
  }
}
