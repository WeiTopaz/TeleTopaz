import https from "node:https";
import { URL } from "node:url";
import { buildCheckServerIdentity } from "../util/tls.js";
import {
  InlineKeyboardMarkup,
  MessageReaction,
  TelegramApiResponse,
  TelegramChat,
  TelegramFile,
  TelegramMessage,
  TelegramUpdate
} from "./types.js";

const TELEGRAM_HOST = "api.telegram.org";
const REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

export type TelegramApiOptions = {
  token: string;
  fingerprints: string[];
};

export class TelegramApi {
  private readonly token: string;
  private readonly agent: https.Agent;

  constructor(options: TelegramApiOptions) {
    this.token = options.token;
    this.agent = new https.Agent({
      checkServerIdentity: buildCheckServerIdentity(TELEGRAM_HOST, options.fingerprints)
    });
  }

  private async call<T>(method: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const url = new URL(`https://${TELEGRAM_HOST}/bot${this.token}/${method}`);
    const body = JSON.stringify(payload);
    const timeout = timeoutMs ?? REQUEST_TIMEOUT_MS;

    const response = await new Promise<TelegramApiResponse<T>>((resolve, reject) => {
      const req = https.request(
        url,
        {
          method: "POST",
          agent: this.agent,
          timeout,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body)
          }
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.on("end", () => {
            try {
              const text = Buffer.concat(chunks).toString("utf8");
              const parsed = JSON.parse(text) as TelegramApiResponse<T>;
              resolve(parsed);
            } catch (err) {
              reject(err);
            }
          });
        }
      );
      req.on("timeout", () => {
        req.destroy(new Error(`Telegram API timeout: ${method} (${timeout}ms)`));
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });

    if (!response.ok) {
      throw new Error(response.description || `Telegram API error: ${method}`);
    }
    return response.result;
  }

  private async callPlain<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const cleaned: Record<string, unknown> = { ...payload };
    delete cleaned.parse_mode;
    const url = new URL(`https://${TELEGRAM_HOST}/bot${this.token}/${method}`);
    const body = JSON.stringify(cleaned);

    const response = await new Promise<TelegramApiResponse<T>>((resolve, reject) => {
      const req = https.request(
        url,
        {
          method: "POST",
          agent: this.agent,
          timeout: REQUEST_TIMEOUT_MS,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body)
          }
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.on("end", () => {
            try {
              const text = Buffer.concat(chunks).toString("utf8");
              const parsed = JSON.parse(text) as TelegramApiResponse<T>;
              resolve(parsed);
            } catch (err) {
              reject(err);
            }
          });
        }
      );
      req.on("timeout", () => {
        req.destroy(new Error(`Telegram API timeout: ${method} (${REQUEST_TIMEOUT_MS}ms)`));
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });

    if (!response.ok) {
      throw new Error(response.description || `Telegram API error: ${method}`);
    }
    return response.result;
  }

  async getUpdates(offset: number | undefined, timeout: number, limit?: number): Promise<TelegramUpdate[]> {
    // getUpdates uses Telegram long-polling; allow extra time beyond the server-side timeout
    return this.call<TelegramUpdate[]>("getUpdates", {
      offset,
      timeout,
      limit
    }, (timeout + 10) * 1000);
  }

  async sendMessage(options: {
    chat_id: number | string;
    text: string;
    parse_mode?: string;
    reply_to_message_id?: number;
    reply_markup?: InlineKeyboardMarkup;
    disable_web_page_preview?: boolean;
  }): Promise<TelegramMessage> {
    return this.call<TelegramMessage>("sendMessage", options);
  }

  async editMessageText(options: {
    chat_id: number | string;
    message_id: number;
    text: string;
    parse_mode?: string;
    reply_markup?: InlineKeyboardMarkup;
    disable_web_page_preview?: boolean;
  }): Promise<TelegramMessage> {
    return this.call<TelegramMessage>("editMessageText", options);
  }

  async editMessageTextPlain(options: {
    chat_id: number | string;
    message_id: number;
    text: string;
    reply_markup?: InlineKeyboardMarkup;
    disable_web_page_preview?: boolean;
  }): Promise<TelegramMessage> {
    return this.callPlain<TelegramMessage>("editMessageText", options);
  }

  async answerCallbackQuery(callback_query_id: string): Promise<boolean> {
    return this.call<boolean>("answerCallbackQuery", { callback_query_id });
  }

  async setMessageReaction(options: {
    chat_id: number | string;
    message_id: number;
    reaction: MessageReaction[];
  }): Promise<boolean> {
    return this.call<boolean>("setMessageReaction", options);
  }

  async getFile(file_id: string): Promise<TelegramFile> {
    return this.call<TelegramFile>("getFile", { file_id });
  }

  async getChat(chat_id: number | string): Promise<TelegramChat> {
    return this.call<TelegramChat>("getChat", { chat_id });
  }

  async downloadFile(filePath: string, maxBytes: number): Promise<Buffer> {
    const url = new URL(`https://${TELEGRAM_HOST}/file/bot${this.token}/${filePath}`);
    if (url.hostname !== TELEGRAM_HOST) {
      throw new Error("Unexpected Telegram file host");
    }

    return new Promise<Buffer>((resolve, reject) => {
      const req = https.request(
        url,
        { method: "GET", agent: this.agent, timeout: DOWNLOAD_TIMEOUT_MS },
        (res) => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Telegram file download failed: ${res.statusCode}`));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk) => {
            const buf = Buffer.from(chunk);
            size += buf.length;
            if (size > maxBytes) {
              req.destroy(new Error("Downloaded file exceeds size limit"));
              return;
            }
            chunks.push(buf);
          });
          res.on("end", () => resolve(Buffer.concat(chunks)));
        }
      );
      req.on("timeout", () => {
        req.destroy(new Error(`Telegram file download timeout (${DOWNLOAD_TIMEOUT_MS}ms)`));
      });
      req.on("error", reject);
      req.end();
    });
  }
}

export function getTelegramHost(): string {
  return TELEGRAM_HOST;
}
