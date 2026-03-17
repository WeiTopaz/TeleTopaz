/**
 * 主動重建通知去重複機制 - 單元測試
 *
 * 測試情境：
 * 1. 首次重建 → 發送新訊息 (1)，儲存 lastProactiveRebuildNotice
 * 2. 連續重建（無使用者操作）→ 編輯原訊息，計數遞增 (2)、(3)…
 * 3. 使用者傳訊後重建 → 重新發送新訊息 (1)
 * 4. 靜默時段重建 → 不發送/不編輯通知，狀態不變
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TeleTopazService } from "../src/bot.js";
import type { TelegramApi } from "../src/telegram/api.js";
import type { AgentContext } from "../src/session/state.js";

// UTC 時間點：UTC+8 = 12:00（非靜默時段）
const NON_QUIET_UTC = new Date("2026-03-17T04:00:00Z").getTime();
// UTC 時間點：UTC+8 = 03:00（靜默時段）
const QUIET_UTC = new Date("2026-03-17T19:00:00Z").getTime();

const CHAT_ID = 12345;
const SESSION_IDLE_REBUILD_MS = 60 * 60 * 1000; // 1 小時（同 bot.ts 常數）

function createBot() {
  const mockApi = {
    sendMessage: vi.fn(),
    editMessageText: vi.fn(),
    editMessageTextPlain: vi.fn(),
    getUpdates: vi.fn().mockResolvedValue([]),
    answerCallbackQuery: vi.fn(),
    setMessageReaction: vi.fn(),
    getFile: vi.fn(),
    getChat: vi.fn(),
    deleteWebhook: vi.fn()
  } as unknown as TelegramApi;

  const bot = new TeleTopazService(mockApi, String(CHAT_ID), String(CHAT_ID), 0);
  return { bot, mockApi };
}

/** 設置一個已閒置的會話狀態（使 checkSessionHealth 判定需重建） */
function setupIdleSession(bot: TeleTopazService, nowMs: number): AgentContext {
  const state = (bot as any).getOrCreateState(CHAT_ID) as AgentContext;
  state.session = {} as any;
  state.workDir = "/fake/project";
  state.model = "fake-model";
  state.processing = false;
  state.resetting = false;
  state.pendingRecovery = undefined;
  // 讓 sessionLastActivityAt 超過閒置閾值
  state.sessionCreatedAt = nowMs - SESSION_IDLE_REBUILD_MS * 2;
  state.sessionLastActivityAt = nowMs - SESSION_IDLE_REBUILD_MS * 2;
  return state;
}

/** 模擬 createSession 保持 session 為 truthy（重建成功） */
function mockCreateSession(bot: TeleTopazService) {
  return vi.spyOn(bot as any, "createSession").mockImplementation(async (chatId: number) => {
    const state = (bot as any).getOrCreateState(chatId) as AgentContext;
    state.session = {} as any;
  });
}

describe("主動重建通知去重複機制", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  describe("checkSessionHealth() - 非靜默時段", () => {
    it("首次重建：發送新訊息並附加 (1)，儲存 lastProactiveRebuildNotice", async () => {
      vi.setSystemTime(NON_QUIET_UTC);
      const { bot } = createBot();
      const state = setupIdleSession(bot, NON_QUIET_UTC);
      mockCreateSession(bot);

      const sentMessageId = 42;
      const safeSendSpy = vi
        .spyOn(bot as any, "safeSend")
        .mockResolvedValue({ message_id: sentMessageId });

      await (bot as any).checkSessionHealth();

      // 應發送一則新訊息，且訊息包含 "(1)"
      expect(safeSendSpy).toHaveBeenCalledOnce();
      const sentText: string = safeSendSpy.mock.calls[0]?.[1] ?? "";
      expect(sentText).toContain("(1)");
      expect(sentText).toContain("已自動重建工作階段");

      // 應儲存 lastProactiveRebuildNotice
      expect(state.lastProactiveRebuildNotice).toEqual({
        messageId: sentMessageId,
        count: 1
      });
    });

    it("連續第二次重建：編輯原訊息為 (2)，更新計數", async () => {
      vi.setSystemTime(NON_QUIET_UTC);
      const { bot } = createBot();
      const state = setupIdleSession(bot, NON_QUIET_UTC);
      mockCreateSession(bot);

      // 模擬已有第一次重建的通知
      const existingMessageId = 77;
      state.lastProactiveRebuildNotice = { messageId: existingMessageId, count: 1 };

      const editSpy = vi.spyOn(bot as any, "editMessageSafe").mockResolvedValue(undefined);
      const safeSendSpy = vi.spyOn(bot as any, "safeSend").mockResolvedValue(undefined);

      await (bot as any).checkSessionHealth();

      // 應編輯原訊息，不應發送新訊息
      expect(editSpy).toHaveBeenCalledOnce();
      expect(safeSendSpy).not.toHaveBeenCalled();

      // 編輯的訊息 ID 應為原訊息
      const [editedChatId, editedMsgId, editedText] = editSpy.mock.calls[0] ?? [];
      expect(editedChatId).toBe(CHAT_ID);
      expect(editedMsgId).toBe(existingMessageId);
      expect(editedText).toContain("(2)");

      // 計數應更新為 2
      expect(state.lastProactiveRebuildNotice).toEqual({
        messageId: existingMessageId,
        count: 2
      });
    });

    it("連續第三次重建：計數繼續遞增至 (3)", async () => {
      vi.setSystemTime(NON_QUIET_UTC);
      const { bot } = createBot();
      const state = setupIdleSession(bot, NON_QUIET_UTC);
      mockCreateSession(bot);

      state.lastProactiveRebuildNotice = { messageId: 88, count: 2 };

      const editSpy = vi.spyOn(bot as any, "editMessageSafe").mockResolvedValue(undefined);

      await (bot as any).checkSessionHealth();

      const editedText: string = editSpy.mock.calls[0]?.[2] ?? "";
      expect(editedText).toContain("(3)");
      expect(state.lastProactiveRebuildNotice?.count).toBe(3);
    });

    it("safeSend 失敗（回傳 undefined）：不儲存 lastProactiveRebuildNotice", async () => {
      vi.setSystemTime(NON_QUIET_UTC);
      const { bot } = createBot();
      const state = setupIdleSession(bot, NON_QUIET_UTC);
      mockCreateSession(bot);

      vi.spyOn(bot as any, "safeSend").mockResolvedValue(undefined);

      await (bot as any).checkSessionHealth();

      expect(state.lastProactiveRebuildNotice).toBeUndefined();
    });
  });

  describe("checkSessionHealth() - 靜默時段", () => {
    it("靜默時段：不發送訊息，lastProactiveRebuildNotice 保持不變", async () => {
      vi.setSystemTime(QUIET_UTC);
      const { bot } = createBot();
      const state = setupIdleSession(bot, QUIET_UTC);
      mockCreateSession(bot);

      const safeSendSpy = vi.spyOn(bot as any, "safeSend").mockResolvedValue(undefined);
      const editSpy = vi.spyOn(bot as any, "editMessageSafe").mockResolvedValue(undefined);

      await (bot as any).checkSessionHealth();

      expect(safeSendSpy).not.toHaveBeenCalled();
      expect(editSpy).not.toHaveBeenCalled();
      expect(state.lastProactiveRebuildNotice).toBeUndefined();
    });

    it("靜默時段：有既存通知時，lastProactiveRebuildNotice 維持原值不被更動", async () => {
      vi.setSystemTime(QUIET_UTC);
      const { bot } = createBot();
      const state = setupIdleSession(bot, QUIET_UTC);
      mockCreateSession(bot);

      const originalNotice = { messageId: 55, count: 1 };
      state.lastProactiveRebuildNotice = originalNotice;

      vi.spyOn(bot as any, "safeSend").mockResolvedValue(undefined);
      vi.spyOn(bot as any, "editMessageSafe").mockResolvedValue(undefined);

      await (bot as any).checkSessionHealth();

      expect(state.lastProactiveRebuildNotice).toEqual(originalNotice);
    });
  });

  describe("handleMessage() - 清除 lastProactiveRebuildNotice", () => {
    it("使用者傳送訊息時，清除 lastProactiveRebuildNotice", async () => {
      vi.setSystemTime(NON_QUIET_UTC);
      const { bot } = createBot();

      // 直接初始化狀態（不需實際重建）
      const state = (bot as any).getOrCreateState(CHAT_ID) as AgentContext;
      state.lastProactiveRebuildNotice = { messageId: 99, count: 2 };

      // 讓 handleMessage 的後續處理不崩潰
      vi.spyOn(bot as any, "handleCommand").mockResolvedValue(undefined);
      vi.spyOn(bot as any, "handleImages").mockResolvedValue(false);
      vi.spyOn(bot as any, "sendPreparedPrompt").mockResolvedValue(undefined);
      vi.spyOn(bot as any, "safeSend").mockResolvedValue({ message_id: 1 });

      // 模擬非指令的使用者訊息
      const fakeMessage = {
        message_id: 200,
        chat: { id: CHAT_ID },
        from: { id: CHAT_ID },
        text: "繼續工作"
      };

      await (bot as any).handleMessage(fakeMessage);

      expect(state.lastProactiveRebuildNotice).toBeUndefined();
    });

    it("使用者傳送訊息後再次觸發重建：重新發送新訊息 (1)", async () => {
      vi.setSystemTime(NON_QUIET_UTC);
      const { bot } = createBot();
      const state = setupIdleSession(bot, NON_QUIET_UTC);
      mockCreateSession(bot);

      // 初始已有通知（模擬之前的重建）
      state.lastProactiveRebuildNotice = { messageId: 10, count: 3 };

      // 模擬使用者清除了通知
      state.lastProactiveRebuildNotice = undefined;

      const newMessageId = 200;
      const safeSendSpy = vi
        .spyOn(bot as any, "safeSend")
        .mockResolvedValue({ message_id: newMessageId });
      vi.spyOn(bot as any, "editMessageSafe").mockResolvedValue(undefined);

      await (bot as any).checkSessionHealth();

      // 應發送新訊息 (1)，而非繼續編輯舊訊息
      expect(safeSendSpy).toHaveBeenCalledOnce();
      const sentText: string = safeSendSpy.mock.calls[0]?.[1] ?? "";
      expect(sentText).toContain("(1)");
      expect(state.lastProactiveRebuildNotice).toEqual({ messageId: newMessageId, count: 1 });
    });
  });

  describe("狀態初始化", () => {
    it("getOrCreateState 建立的新狀態，lastProactiveRebuildNotice 預設為 undefined", () => {
      const { bot } = createBot();
      const state = (bot as any).getOrCreateState(CHAT_ID) as AgentContext;
      expect(state.lastProactiveRebuildNotice).toBeUndefined();
    });
  });
});
