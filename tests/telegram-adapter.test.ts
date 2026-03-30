import { describe, it, expect, vi, beforeEach } from "vitest";
import { TelegramAdapter } from "../src/telegram/adapter.js";
import type { TelegramApi } from "../src/telegram/api.js";
import type { TelegramMessage } from "../src/telegram/types.js";

function makeMockApi(): TelegramApi {
  return {
    sendMessage: vi.fn(),
    editMessageText: vi.fn(),
    editMessageTextPlain: vi.fn(),
    setMessageReaction: vi.fn(),
    sendChatAction: vi.fn(),
  } as unknown as TelegramApi;
}

function makeMessage(id: number): TelegramMessage {
  return { message_id: id, date: 0, chat: { id: 1, type: "private" } };
}

const OWNER_CHAT_ID = "100";
const OWNER_USER_ID = "200";

describe("TelegramAdapter", () => {
  let api: TelegramApi;
  let adapter: TelegramAdapter;

  beforeEach(() => {
    api = makeMockApi();
    adapter = new TelegramAdapter(api, OWNER_CHAT_ID, OWNER_USER_ID);
  });

  describe("name", () => {
    it("is 'telegram'", () => {
      expect(adapter.name).toBe("telegram");
    });
  });

  describe("isOwner", () => {
    it("returns true for owner user ID", () => {
      expect(adapter.isOwner(OWNER_USER_ID)).toBe(true);
    });

    it("returns false for non-owner user ID", () => {
      expect(adapter.isOwner("999")).toBe(false);
    });
  });

  describe("sendMessage", () => {
    it("calls api.sendMessage and returns message_id as string", async () => {
      vi.mocked(api.sendMessage).mockResolvedValue(makeMessage(42));
      const id = await adapter.sendMessage("100", "hello");
      expect(api.sendMessage).toHaveBeenCalledOnce();
      expect(id).toBe("42");
    });

    it("falls back to plain text if MarkdownV2 send fails", async () => {
      vi.mocked(api.sendMessage)
        .mockRejectedValueOnce(new Error("parse error"))
        .mockResolvedValueOnce(makeMessage(99));
      const id = await adapter.sendMessage("100", "hello *world*");
      expect(api.sendMessage).toHaveBeenCalledTimes(2);
      expect(id).toBe("99");
    });

    it("throws if both attempts fail", async () => {
      vi.mocked(api.sendMessage).mockRejectedValue(new Error("network error"));
      await expect(adapter.sendMessage("100", "hello")).rejects.toThrow("network error");
    });

    it("passes replyTo as reply_to_message_id", async () => {
      vi.mocked(api.sendMessage).mockResolvedValue(makeMessage(1));
      await adapter.sendMessage("100", "hello", { replyTo: "55" });
      expect(vi.mocked(api.sendMessage).mock.calls[0]?.[0]).toMatchObject({
        reply_to_message_id: 55,
      });
    });
  });

  describe("editMessage", () => {
    it("calls api.editMessageText", async () => {
      vi.mocked(api.editMessageText).mockResolvedValue(makeMessage(10));
      await adapter.editMessage("100", "10", "updated text");
      expect(api.editMessageText).toHaveBeenCalledOnce();
    });

    it("falls back to plain text if MarkdownV2 edit fails", async () => {
      vi.mocked(api.editMessageText).mockRejectedValue(new Error("edit failed"));
      vi.mocked(api.editMessageTextPlain).mockResolvedValue(makeMessage(10));
      await adapter.editMessage("100", "10", "updated text");
      expect(api.editMessageTextPlain).toHaveBeenCalledOnce();
    });
  });

  describe("sendReaction", () => {
    it("calls api.setMessageReaction with correct params", async () => {
      vi.mocked(api.setMessageReaction).mockResolvedValue(true);
      await adapter.sendReaction("100", "10", "👍");
      expect(api.setMessageReaction).toHaveBeenCalledWith({
        chat_id: 100,
        message_id: 10,
        reaction: [{ type: "emoji", emoji: "👍" }],
      });
    });
  });

  describe("sendTyping", () => {
    it("calls api.sendChatAction with typing", async () => {
      vi.mocked(api.sendChatAction).mockResolvedValue(true);
      await adapter.sendTyping("100");
      expect(api.sendChatAction).toHaveBeenCalledWith({
        chat_id: 100,
        action: "typing",
      });
    });
  });

  describe("formatMarkdown", () => {
    it("converts markdown to Telegram MarkdownV2", () => {
      const result = adapter.formatMarkdown("**bold**");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe("splitMessage", () => {
    it("returns array of chunks", () => {
      const chunks = adapter.splitMessage("hello");
      expect(Array.isArray(chunks)).toBe(true);
      expect(chunks.length).toBeGreaterThan(0);
    });
  });
});
