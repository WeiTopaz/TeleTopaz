import { TelegramChat, TelegramMessage } from "../telegram/types.js";

export function parseIndex(input: string | undefined, max: number): number {
  if (!input) return -1;
  const value = Number.parseInt(input.trim(), 10);
  if (!Number.isFinite(value) || value < 1 || value >= max + 1) return -1;
  return value - 1;
}

export function formatChatName(message: TelegramMessage): string {
  try {
    const chat = message.chat;
    if (chat.type === "private") {
      const first = message.from?.first_name ?? chat.first_name ?? "";
      const last = message.from?.last_name ?? chat.last_name ?? "";
      const combined = `${first} ${last}`.trim();
      if (combined) return combined;
      const username = message.from?.username ?? chat.username;
      if (username) return `@${username}`;
      return "未知";
    }

    const title = chat.title;
    if (title) return title;
    const username = chat.username ?? message.from?.username;
    if (username) return `@${username}`;
    return String(chat.id);
  } catch {
    return "未知";
  }
}

export function formatChatDisplayName(chat: TelegramChat): string {
  try {
    if (chat.type === "private") {
      const combined = `${chat.first_name ?? ""} ${chat.last_name ?? ""}`.trim();
      if (combined) return combined;
      if (chat.username) return `@${chat.username}`;
      return "未知";
    }
    if (chat.title) return chat.title;
    if (chat.username) return `@${chat.username}`;
    return String(chat.id);
  } catch {
    return "未知";
  }
}

export function formatJsonResult(input: unknown): string | undefined {
  if (input === null || input === undefined) return undefined;
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return input;
    }
  }
  if (typeof input === "object") {
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return String(input);
    }
  }
  return String(input);
}
