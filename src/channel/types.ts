export interface SendOptions {
  /** Reply to a specific message by its string ID (as returned by sendMessage). */
  replyTo?: string;
  silent?: boolean;
  keyboard?: unknown;
}

/**
 * Minimal abstraction for a chat channel (Telegram, WhatsApp, …).
 * Implementations wrap the channel-specific SDK and provide a uniform API
 * for the BotEngine (Phase 3).
 *
 * Message IDs are always returned/accepted as strings; each adapter is
 * responsible for encoding/decoding its native ID format.
 */
export interface ChannelAdapter {
  /** Channel identifier used for logging and metrics. */
  readonly name: string;

  /** Send a text message. Returns the sent message's string ID. */
  sendMessage(channelId: string, text: string, options?: SendOptions): Promise<string>;

  /** Edit a previously sent message. No-op if the channel does not support editing. */
  editMessage(channelId: string, messageId: string, text: string): Promise<void>;

  /**
   * React to a message.
   * `messageId` must be the value previously returned by `sendMessage`.
   * No-op if the channel does not support reactions.
   */
  sendReaction(channelId: string, messageId: string, emoji: string): Promise<void>;

  /** Send a typing / composing indicator. */
  sendTyping(channelId: string): Promise<void>;

  /** Convert Markdown to the channel's native text format. */
  formatMarkdown(text: string): string;

  /** Split a long message into chunks that fit the channel's limit. */
  splitMessage(text: string): string[];

  /** Return true if `senderId` belongs to an authorised owner. */
  isOwner(senderId: string): boolean;
}
