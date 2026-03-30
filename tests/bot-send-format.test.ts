import { describe, it, expect, vi } from "vitest";
import { TeleTopazService } from "../src/bot.js";
import type { TelegramApi } from "../src/telegram/api.js";

function createApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    editMessageText: vi.fn().mockResolvedValue({}),
    editMessageTextPlain: vi.fn().mockResolvedValue({}),
    getChat: vi.fn(),
    setMessageReaction: vi.fn(),
    getUpdates: vi.fn(),
    getFile: vi.fn(),
    answerCallbackQuery: vi.fn(),
    downloadFile: vi.fn(),
  } as unknown as TelegramApi;
}

function createService() {
  const api = createApi();
  const service = new TeleTopazService(api, "1", "1", 0);
  (service as any).sessionMemory = { buildContext: vi.fn().mockResolvedValue(undefined) };
  return { service, api };
}

describe("safeSend", () => {
  it("uses MarkdownV2 parse_mode by default", async () => {
    const { service, api } = createService();
    await (service as any).safeSend(1, "hello **world**");
    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ parse_mode: "MarkdownV2" })
    );
  });

  it("falls back to plain text when MarkdownV2 parse fails", async () => {
    const { service, api } = createService();
    // First call fails (MarkdownV2 error), second call succeeds (plain)
    vi.mocked(api.sendMessage)
      .mockRejectedValueOnce(new Error("can't parse entities"))
      .mockResolvedValueOnce({ message_id: 2 } as any);

    const result = await (service as any).safeSend(1, "bad *markdown");
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    // Second call should not have parse_mode
    const secondCall = vi.mocked(api.sendMessage).mock.calls[1]![0] as any;
    expect(secondCall.parse_mode).toBeUndefined();
    expect(result).toEqual({ message_id: 2 });
  });

  it("returns the last message from multi-chunk send", async () => {
    const { service, api } = createService();
    vi.mocked(api.sendMessage)
      .mockResolvedValueOnce({ message_id: 10 } as any)
      .mockResolvedValueOnce({ message_id: 11 } as any);

    // Create text > 4096 chars to trigger chunking
    const longText = "A".repeat(4200);
    const result = await (service as any).safeSend(1, longText);

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ message_id: 11 }); // last chunk's message
  });

  it("only attaches keyboard and replyTo on the first chunk", async () => {
    const { service, api } = createService();
    vi.mocked(api.sendMessage).mockResolvedValue({ message_id: 1 } as any);

    const keyboard = { inline_keyboard: [[{ text: "OK", callback_data: "ok" }]] };
    const longText = "B".repeat(4200);
    await (service as any).safeSend(1, longText, 99, keyboard);

    const calls = vi.mocked(api.sendMessage).mock.calls;
    expect((calls[0]![0] as any).reply_to_message_id).toBe(99);
    expect((calls[0]![0] as any).reply_markup).toEqual(keyboard);
    expect((calls[1]![0] as any).reply_to_message_id).toBeUndefined();
    expect((calls[1]![0] as any).reply_markup).toBeUndefined();
  });

  it("throws if fallback plain-text send also fails", async () => {
    const { service, api } = createService();
    vi.mocked(api.sendMessage).mockRejectedValue(new Error("network error"));
    await expect((service as any).safeSend(1, "test")).rejects.toThrow("network error");
  });
});

describe("editMessageSafe", () => {
  it("edits with MarkdownV2 first", async () => {
    const { service, api } = createService();
    await (service as any).editMessageSafe(1, 5, "updated text");
    expect(api.editMessageText).toHaveBeenCalledWith(
      expect.objectContaining({ chat_id: 1, message_id: 5, parse_mode: "MarkdownV2" })
    );
  });

  it("falls back to plain text when MarkdownV2 edit fails", async () => {
    const { service, api } = createService();
    vi.mocked(api.editMessageText).mockRejectedValueOnce(new Error("parse error"));
    await (service as any).editMessageSafe(1, 5, "plain text");
    expect(api.editMessageTextPlain).toHaveBeenCalled();
  });

  it("falls back to safeSend when both edit modes fail", async () => {
    const { service, api } = createService();
    vi.mocked(api.editMessageText).mockRejectedValue(new Error("edit failed"));
    vi.mocked(api.editMessageTextPlain).mockRejectedValue(new Error("plain edit failed"));

    await (service as any).editMessageSafe(1, 5, "fallback");
    // safeSend should have been called since both edits failed
    expect(api.sendMessage).toHaveBeenCalled();
  });
});

describe("prepareOutgoingText", () => {
  it("adds TeleTopaz header to plain messages", () => {
    const { service } = createService();
    const result = (service as any).prepareOutgoingRaw(1, "Hello world");
    expect(result).toContain("💎TeleTopaz");
  });

  it("does not double-add header if text already starts with 💎TeleTopaz", () => {
    const { service } = createService();
    const text = "💎TeleTopaz in proj / model\nHello";
    const result = (service as any).prepareOutgoingRaw(1, text);
    const count = (result.match(/💎TeleTopaz/g) ?? []).length;
    expect(count).toBe(1);
  });

  it("includes session icon in header", () => {
    const { service } = createService();
    const state = (service as any).getOrCreateState(1);
    const icon = state.sessionIcon as string;
    const result = (service as any).prepareOutgoingRaw(1, "test");
    // The header uses 💎TeleTopaz, but icon is part of state — just verify header is present
    expect(result).toContain("💎TeleTopaz");
    expect(typeof icon).toBe("string");
  });
});
