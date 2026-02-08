import { describe, it, expect, vi } from "vitest";
import { TeleTopazService } from "../src/bot.js";
import { TelegramApi } from "../src/telegram/api.js";

describe("TeleTopazService.handleToolComplete", () => {
  it("retries reaction with chat-supported emojis after REACTION_INVALID", async () => {
    const api = {
      editMessageText: vi.fn().mockResolvedValue({}),
      editMessageTextPlain: vi.fn().mockResolvedValue({}),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      getChat: vi.fn().mockResolvedValue({
        id: 1,
        type: "private",
        available_reactions: [{ type: "emoji", emoji: "✅" }]
      }),
      setMessageReaction: vi
        .fn()
        .mockRejectedValueOnce(new Error("Bad Request: REACTION_INVALID"))
        .mockResolvedValueOnce(true)
    } as unknown as TelegramApi;

    const service = new TeleTopazService(api, "1", "1", 0);
    (service as unknown as { guardrailsPromise: Promise<unknown> }).guardrailsPromise = Promise.resolve({
      version: 1,
      maxPromptLength: 4000,
      denyRules: [],
      allowRules: []
    });

    const state = (service as unknown as { getOrCreateState: (chatId: number) => unknown })
      .getOrCreateState(1) as {
      toolMessageMap: Map<string, unknown>;
      reactionDisabled?: boolean;
    };

    state.toolMessageMap.set("call-1", {
      messageId: 123,
      resultKey: "result-1",
      paramsKey: "params-1",
      toolName: "test-tool"
    });

    await expect(
      (service as unknown as {
        handleToolComplete: (chatId: number, state: unknown, payload: unknown) => Promise<void>;
      }).handleToolComplete(1, state, { toolCallId: "call-1", result: { ok: true } })
    ).resolves.toBeUndefined();

    expect(api.getChat).toHaveBeenCalledOnce();
    expect(api.setMessageReaction).toHaveBeenCalledTimes(2);
  });
});
