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
 * 所有工具操作自動核准（擁有者身份已透過手機掃碼驗證）。
 */

import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { WhatsAppClient, type WaMessage } from "./client.js";
import { CopilotSdkClient } from "../copilot/sdk.js";
import { ClaudeCodeSdkClient } from "../claude/sdk.js";
import { GeminiSdkClient } from "../gemini/sdk.js";
import { GeminiPtyClient } from "../gemini/pty-session.js";
import { SessionMemoryStore } from "../session/memory-store.js";
import { buildPersonaPrompt } from "../session/persona.js";
import { loadConfiguredRuntimeConfig, loadWaOwnerJids } from "../config/secrets.js";
import { loadDirectoryPatterns, expandDirectoryPatterns } from "../config/directories.js";
import { DEFAULT_MODEL_ENTRY, parseModelEntry } from "../config/models.js";
import { logger } from "../util/logger.js";
import type { AiClient, AiEvent, AiSession, ProviderType } from "../provider/types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface WaState {
  client: AiClient | undefined;
  session: AiSession | undefined;
  workDir: string;
  model: string;
  provider: ProviderType;
  processing: boolean;
  queue: string[];
  lastPrompt: string | undefined;
  lastReply: string | undefined;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveApprovalMode(p: ProviderType): "plan" | "auto_edit" | undefined {
  if (p === "gemini") return "plan";
  if (p === "claude-code") return "auto_edit";
  return undefined;
}

function createProviderClient(provider: ProviderType): AiClient {
  if (provider === "gemini") {
    return process.env["TELETOPAZ_USE_PTY"] === "1" ? new GeminiPtyClient() : new GeminiSdkClient();
  }
  if (provider === "claude-code") return new ClaudeCodeSdkClient();
  return new CopilotSdkClient();
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
  return null;
}

function splitText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += limit) chunks.push(text.slice(i, i + limit));
  return chunks;
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
    const ownerCheck = this.isOwner(senderJid);
    logger.info("WA message received", { from: msg.from, sender: senderJid, isOwner: ownerCheck, isGroup: msg.isGroup, content: msg.content.slice(0, 50) });
    if (!ownerCheck) return;
    const text = msg.content.trim();
    if (!text) return;

    if (text.startsWith("/")) {
      await this.handleCommand(msg.from, text);
      return;
    }

    const state = this.sessions.get(msg.from);
    if (state?.processing) {
      state.queue.push(text);
      await this.send(msg.from, `⏳已排隊 (${state.queue.length})`);
      return;
    }
    await this.processPrompt(msg.from, text);
  }

  // ─── Commands ─────────────────────────────────────────────────────────────

  private async handleCommand(jid: string, text: string): Promise<void> {
    const parts = text.split(/\s+/);
    const cmd = parts[0]!;
    const arg = parts[1];

    switch (cmd) {
      case "/model": {
        const state = this.sessions.get(jid);
        if (!arg) {
          await this.send(jid, `目前模型：${state?.model ?? this.defaultModel}`);
          return;
        }
        const parsed = parseModelEntry(arg);
        if (state) {
          await this.clearSession(jid);
          state.model = parsed.model;
          state.provider = parsed.provider;
        } else {
          this.sessions.set(jid, this.newState(parsed.model, parsed.provider));
        }
        await this.send(jid, `✅ 模型已切換至 ${arg}`);
        return;
      }

      case "/project": {
        const dirs = await this.loadDirs();
        if (!dirs.length) {
          await this.send(jid, "沒有可用的專案");
          return;
        }
        if (arg) {
          const idx = parseInt(arg, 10) - 1;
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
        const info = state
          ? `📂 ${path.basename(state.workDir)}\n🤖 ${state.model}\n🔌 ${state.session ? "已連線" : "未連線"}`
          : `🤖 ${this.defaultModel}\n🔌 未初始化`;
        await this.send(jid, info);
        return;
      }

      default:
        await this.send(jid, `未知命令：${cmd}\n可用：/model /project /clear /info`);
    }
  }

  // ─── Session management ───────────────────────────────────────────────────

  private newState(model: string, provider: ProviderType): WaState {
    return {
      client: undefined,
      session: undefined,
      workDir: this.defaultWorkDir ?? "",
      model,
      provider,
      processing: false,
      queue: [],
      lastPrompt: undefined,
      lastReply: undefined,
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
    state.queue = [];
  }

  // ─── AI session ───────────────────────────────────────────────────────────

  private async processPrompt(jid: string, prompt: string): Promise<void> {
    let state = this.sessions.get(jid);
    if (!state) {
      state = this.newState(this.defaultModel, this.defaultProvider);
      this.sessions.set(jid, state);
    }

    if (!state.session) {
      if (!state.workDir) {
        await this.send(jid, "❌ 請先 /project 設定工作目錄");
        return;
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
        session.onEvent((event: AiEvent) => void this.handleAiEvent(jid, event));
      } catch (err) {
        await client.stop().catch(() => undefined);
        await this.send(jid, `❌ 建立工作階段失敗：${String(err)}`);
        return;
      }
    }

    state.processing = true;
    state.lastPrompt = prompt;
    state.lastReply = undefined;
    await this.send(jid, "⏳處理中…");
    await state.session.send(prompt).catch(async (err: unknown) => {
      if (state) state.processing = false;
      await this.send(jid, `❌ 送出失敗：${String(err)}`);
    });
  }

  private async handleAiEvent(jid: string, event: AiEvent): Promise<void> {
    const state = this.sessions.get(jid);
    if (!state) return;

    const type = event.type ?? (event as { event?: string }).event;
    const data = event.data ?? event;

    switch (type) {
      case "assistant.message": {
        const content = extractText(data);
        if (content) {
          state.lastReply = content;
          for (const chunk of splitText(content, 4000)) {
            await this.send(jid, chunk);
          }
        }
        return;
      }
      case "session.idle": {
        const { lastPrompt: prompt, lastReply: reply, workDir } = state;
        state.processing = false;
        state.lastPrompt = undefined;
        state.lastReply = undefined;

        if (prompt || reply) {
          const chatId = jidToId(jid);
          if (prompt) await this.sessionMemory.append({ chatId, workDir }, "user", prompt).catch(() => undefined);
          if (reply) await this.sessionMemory.append({ chatId, workDir }, "assistant", reply).catch(() => undefined);
        }

        const next = state.queue.shift();
        if (next) void this.processPrompt(jid, next);
        return;
      }
    }
  }

  private async send(jid: string, text: string): Promise<void> {
    logger.info("WA sending", { jid, text: text.slice(0, 80) });
    await this.wa.sendMessage(jid, text).catch((err: unknown) => logger.error("WA send failed", { jid, err: String(err) }));
  }
}
