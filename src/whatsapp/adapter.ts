import { markdownToWhatsApp, splitLongMessage } from "./markdown.js";
import type { WhatsAppClient, WaMessageKey } from "./client.js";
import type { ChannelAdapter, SendOptions } from "../channel/types.js";

const MSG_LIMIT = 4000;

export class WhatsAppAdapter implements ChannelAdapter {
  readonly name = "whatsapp";

  constructor(
    private readonly client: WhatsAppClient,
    private readonly ownerJids: Set<string>,
  ) {}

  isOwner(senderId: string): boolean {
    return this.ownerJids.has(senderId);
  }

  formatMarkdown(text: string): string {
    return markdownToWhatsApp(text);
  }

  splitMessage(text: string): string[] {
    return splitLongMessage(text, MSG_LIMIT);
  }

  async sendMessage(channelId: string, text: string, _options?: SendOptions): Promise<string> {
    const key = await this.client.sendMessage(channelId, text);
    if (!key) return "";
    return JSON.stringify(key);
  }

  /** WhatsApp does not support editing sent messages. */
  async editMessage(_channelId: string, _messageId: string, _text: string): Promise<void> {
    // no-op
  }

  async sendReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    if (!messageId) return;
    let key: WaMessageKey;
    try {
      key = JSON.parse(messageId) as WaMessageKey;
    } catch {
      return;
    }
    await this.client.sendReaction(channelId, key, emoji);
  }

  async sendTyping(channelId: string): Promise<void> {
    await this.client.sendPresenceUpdate(channelId, "composing");
  }
}
