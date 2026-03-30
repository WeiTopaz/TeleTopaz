import { markdownToTelegram, splitLongMessage } from "../util/markdown.js";
import { redact } from "../util/redaction.js";
import { logger } from "../util/logger.js";
import type { TelegramApi } from "./api.js";
import type { ChannelAdapter, SendOptions } from "../channel/types.js";

const MESSAGE_LIMIT = 4096;

export class TelegramAdapter implements ChannelAdapter {
  readonly name = "telegram";

  constructor(
    private readonly api: TelegramApi,
    private readonly ownerChatId: string,
    private readonly ownerUserId: string,
  ) {}

  isOwner(senderId: string): boolean {
    return senderId === this.ownerUserId;
  }

  formatMarkdown(text: string): string {
    return markdownToTelegram(text);
  }

  splitMessage(text: string): string[] {
    return splitLongMessage(text, MESSAGE_LIMIT);
  }

  async sendMessage(channelId: string, text: string, options?: SendOptions): Promise<string> {
    const chatId = Number(channelId);
    const chunks = splitLongMessage(text, MESSAGE_LIMIT);
    let lastId = "0";

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i] ?? "";
      const replyTo = i === 0 && options?.replyTo ? Number(options.replyTo) : undefined;

      try {
        const msg = await this.api.sendMessage({
          chat_id: chatId,
          text: markdownToTelegram(chunk),
          parse_mode: "MarkdownV2",
          ...(replyTo !== undefined ? { reply_to_message_id: replyTo } : {}),
          disable_web_page_preview: true,
        });
        lastId = String(msg.message_id);
      } catch {
        const plain = redact(chunk).replace(/[*_~`]/g, "");
        try {
          const msg = await this.api.sendMessage({
            chat_id: chatId,
            text: plain,
            ...(replyTo !== undefined ? { reply_to_message_id: replyTo } : {}),
            disable_web_page_preview: true,
          });
          lastId = String(msg.message_id);
        } catch (err) {
          logger.error("Send message failed", err);
          throw err;
        }
      }
    }

    return lastId;
  }

  async editMessage(channelId: string, messageId: string, text: string): Promise<void> {
    const chatId = Number(channelId);
    const msgId = Number(messageId);

    try {
      await this.api.editMessageText({
        chat_id: chatId,
        message_id: msgId,
        text: markdownToTelegram(text),
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
      });
      return;
    } catch (err) {
      logger.warn("Edit message failed, fallback to plain text", err);
    }

    try {
      await this.api.editMessageTextPlain({
        chat_id: chatId,
        message_id: msgId,
        text: redact(text).replace(/[*_~`]/g, ""),
      });
    } catch (err) {
      logger.warn("Edit message plain failed", err);
    }
  }

  async sendReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.api.setMessageReaction({
      chat_id: Number(channelId),
      message_id: Number(messageId),
      reaction: [{ type: "emoji", emoji }],
    });
  }

  async sendTyping(channelId: string): Promise<void> {
    await this.api.sendChatAction({
      chat_id: Number(channelId),
      action: "typing",
    });
  }
}
