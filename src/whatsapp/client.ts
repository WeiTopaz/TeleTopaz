/**
 * WhatsApp client using @whiskeysockets/baileys.
 * Adapted from https://github.com/HKUDS/nanobot/blob/main/bridge/src/whatsapp.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  extractMessageContent as baileysExtractMessageContent,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface WaMessage {
  id: string;
  from: string;
  content: string;
  timestamp: number;
  isGroup: boolean;
  mediaPaths?: string[];
}

export interface WhatsAppClientOptions {
  authDir: string;
  onMessage: (msg: WaMessage) => void;
  onStatus: (status: "connected" | "disconnected") => void;
}

export class WhatsAppClient {
  private sock: any = null;
  private reconnecting = false;

  constructor(private options: WhatsAppClientOptions) {}

  async connect(): Promise<void> {
    const logger = pino({ level: "silent" });
    const { state, saveCreds } = await useMultiFileAuthState(this.options.authDir);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      version,
      logger,
      printQRInTerminal: false,
      browser: ["TeleTopaz", "cli", "0.1.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    if (this.sock.ws && typeof this.sock.ws.on === "function") {
      this.sock.ws.on("error", (_: Error) => undefined);
    }

    this.sock.ev.on("connection.update", async (update: any) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // Dynamic import — qrcode-terminal is optional and has no TS types
        const qrMod = await import("qrcode-terminal").catch(() => null) as any;
        const gen = qrMod?.default?.generate ?? qrMod?.generate;
        if (gen) {
          console.log("\n📱 掃描 QR Code 連接 WhatsApp（連結裝置）:\n");
          gen(qr, { small: true });
        }
      }

      if (connection === "close") {
        const code = (lastDisconnect?.error as Boom)?.output?.statusCode;
        this.options.onStatus("disconnected");
        if (code !== DisconnectReason.loggedOut && !this.reconnecting) {
          this.reconnecting = true;
          setTimeout(() => {
            this.reconnecting = false;
            void this.connect();
          }, 5000);
        }
      } else if (connection === "open") {
        this.options.onStatus("connected");
      }
    });

    this.sock.ev.on("creds.update", saveCreds);

    this.sock.ev.on("messages.upsert", async ({ messages, type }: { messages: any[]; type: string }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        if (msg.key.fromMe || msg.key.remoteJid === "status@broadcast") continue;

        const unwrapped = baileysExtractMessageContent(msg.message);
        if (!unwrapped) continue;

        const content = this.getTextContent(unwrapped) ?? "";
        const mediaPaths: string[] = [];

        if (unwrapped.imageMessage) {
          const p = await this.downloadMedia(msg, unwrapped.imageMessage.mimetype ?? undefined);
          if (p) mediaPaths.push(p);
        } else if (unwrapped.documentMessage) {
          const p = await this.downloadMedia(
            msg,
            unwrapped.documentMessage.mimetype ?? undefined,
            unwrapped.documentMessage.fileName ?? undefined,
          );
          if (p) mediaPaths.push(p);
        }

        if (!content && mediaPaths.length === 0) continue;

        const from = msg.key.remoteJid ?? "";
        this.options.onMessage({
          id: msg.key.id ?? "",
          from,
          content,
          timestamp: msg.messageTimestamp as number,
          isGroup: from.endsWith("@g.us"),
          ...(mediaPaths.length > 0 ? { mediaPaths } : {}),
        });
      }
    });
  }

  private async downloadMedia(msg: any, mimetype?: string, fileName?: string): Promise<string | null> {
    try {
      const dir = join(this.options.authDir, "..", "wa-media");
      await mkdir(dir, { recursive: true });
      const buf = await downloadMediaMessage(msg, "buffer", {}) as Buffer;
      const ext = "." + ((mimetype ?? "application/octet-stream").split("/").pop()?.split(";")[0] ?? "bin");
      const name = fileName
        ? `wa_${Date.now()}_${randomBytes(4).toString("hex")}_${fileName}`
        : `wa_${Date.now()}_${randomBytes(4).toString("hex")}${ext}`;
      await writeFile(join(dir, name), buf);
      return join(dir, name);
    } catch {
      return null;
    }
  }

  private getTextContent(msg: any): string | null {
    return (
      msg.conversation ??
      msg.extendedTextMessage?.text ??
      msg.imageMessage?.caption ??
      msg.videoMessage?.caption ??
      msg.documentMessage?.caption ??
      null
    );
  }

  async sendMessage(to: string, text: string): Promise<void> {
    if (!this.sock) throw new Error("Not connected");
    await this.sock.sendMessage(to, { text });
  }

  async disconnect(): Promise<void> {
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
  }
}
