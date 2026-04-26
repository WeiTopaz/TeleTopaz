import { afterEach, describe, expect, it, vi } from "vitest";
import { TeleTopazService } from "../src/bot.js";
import { quotaService } from "../src/services/quota.js";
import type { TelegramApi } from "../src/telegram/api.js";
import type { InlineKeyboardMarkup } from "../src/telegram/types.js";

function createApi(): TelegramApi {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    editMessageText: vi.fn().mockResolvedValue({}),
    editMessageTextPlain: vi.fn().mockResolvedValue({}),
    getChat: vi.fn().mockResolvedValue({ id: 1, first_name: "Owner" }),
    setMessageReaction: vi.fn(),
    getUpdates: vi.fn(),
    getFile: vi.fn(),
    getFileContent: vi.fn(),
    answerCallbackQuery: vi.fn()
  } as unknown as TelegramApi;
}

function extractKeyboard(call: unknown[] | undefined): InlineKeyboardMarkup {
  return (call?.[3] ?? { inline_keyboard: [] }) as InlineKeyboardMarkup;
}

describe("TeleTopazService model display", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows auto routing config together with the current routed model in status", async () => {
    const service = new TeleTopazService(createApi(), "1", "1", 0);
    const safeSend = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(quotaService, "checkQuota").mockResolvedValue({
      allowed: true,
      remaining: 9999,
      stats: {
        daily: 1,
        monthly: 3,
        lastResetDate: "2026-03-07",
        lastResetMonth: "2026-03",
        byModel: { "gemini-3.1-pro-preview": 2 }
      }
    });

    const state = (service as unknown as {
      getOrCreateState: (chatId: number) => Record<string, unknown>;
      safeSend: typeof safeSend;
    }).getOrCreateState(1);
    state.mode = "auto";
    state.provider = "copilot";
    state.routerModel = "ctcli:gpt-5-mini";
    state.coreModel = "gmcli:gemini-3.1-pro-preview";
    state.model = "gemini-3.1-pro-preview";
    (service as unknown as { safeSend: typeof safeSend }).safeSend = safeSend;

    await (service as unknown as {
      sendStatus: (chatId: number) => Promise<void>;
    }).sendStatus(1);

    const text = safeSend.mock.calls[0]?.[1];
    expect(text).toContain("⚙️ Auto (目前:gmcli:gemini-3.1-pro-preview / R:ctcli:gpt-5-mini / C:gmcli:gemini-3.1-pro-preview)");
    expect(text).toContain("• gmcli:gemini-3.1-pro-preview: 2");
  });

  it("uses an auto pending label in outgoing headers before the first route is selected", () => {
    const service = new TeleTopazService(createApi(), "1", "1", 0);
    const state = (service as unknown as {
      getOrCreateState: (chatId: number) => Record<string, unknown>;
    }).getOrCreateState(1);

    state.mode = "auto";
    state.model = undefined;
    state.routerModel = "gpt-5-mini";
    state.coreModel = "gemini-3.1-pro-preview";

    const text = (service as unknown as {
      prepareOutgoingRaw: (chatId: number, text: string) => string;
    }).prepareOutgoingRaw(1, "建立工作階段失敗：boom");

    expect(text).toContain("💎TeleTopaz in 尚未選擇專案 / Auto:待路由");
  });

  it("renders the unified model picker with REF models and CLI aliases", async () => {
    const service = new TeleTopazService(createApi(), "1", "1", 0);
    const safeSend = vi.fn().mockResolvedValue(undefined);
    const state = (service as unknown as {
      getOrCreateState: (chatId: number) => Record<string, unknown>;
      safeSend: typeof safeSend;
    }).getOrCreateState(1);

    state.mode = "manual";
    state.provider = "copilot";
    state.model = "gpt-5.4";
    (service as unknown as { safeSend: typeof safeSend }).safeSend = safeSend;

    await (service as unknown as {
      sendUnifiedModelList: (chatId: number) => Promise<void>;
    }).sendUnifiedModelList(1);

    const keyboard = extractKeyboard(safeSend.mock.calls[0]);
    const labels = keyboard.inline_keyboard.flat().map((button) => button.text);

    expect(labels).toEqual(
      expect.arrayContaining([
        "🟢 ctcli:gpt-5.4",
        "ctcli:gpt-5-mini",
        "ctcli:claude-opus-4.6",
        "ctcli:claude-sonnet-4.6",
        "gmcli:gemini-3.1-pro-preview",
        "cccli:claude-opus-4.7",
        "cccli:claude-sonnet-4.6",
        "cccli:claude-haiku-4.5",
        "cdcli:gpt-5.5",
        "cdcli:gpt-5.4-mini"
      ])
    );
    expect(labels.join("\n")).not.toContain("gpt-5.2-codex");
    expect(labels.join("\n")).not.toContain("gemini-3-flash-preview");
  });

  it("uses the current provider when formatting a bare active model name", () => {
    const service = new TeleTopazService(createApi(), "1", "1", 0);
    const state = (service as unknown as {
      getOrCreateState: (chatId: number) => Record<string, unknown>;
    }).getOrCreateState(1);

    state.mode = "manual";
    state.provider = "codex";
    state.model = "gpt-5.5";

    const text = (service as unknown as {
      prepareOutgoingRaw: (chatId: number, text: string) => string;
    }).prepareOutgoingRaw(1, "完成");

    expect(text).toContain("💎TeleTopaz in 尚未選擇專案 / cdcli:gpt-5.5");
  });

  it("keeps the active auto-routed Codex model on the cdcli prefix", () => {
    const service = new TeleTopazService(createApi(), "1", "1", 0);
    const state = (service as unknown as {
      getOrCreateState: (chatId: number) => Record<string, unknown>;
    }).getOrCreateState(1);

    state.mode = "auto";
    state.provider = "codex";
    state.model = "gpt-5.5";
    state.routerModel = "ctcli:gpt-5-mini";
    state.coreModel = "cdcli:gpt-5.5";

    const text = (service as unknown as {
      prepareOutgoingRaw: (chatId: number, text: string) => string;
    }).prepareOutgoingRaw(1, "完成");

    expect(text).toContain("💎TeleTopaz in 尚未選擇專案 / Auto:cdcli:gpt-5.5");
  });

  it("keeps gmcli core models out of the router picker and inside the core picker", async () => {
    const service = new TeleTopazService(createApi(), "1", "1", 0);
    const safeSend = vi.fn().mockResolvedValue(undefined);
    (service as unknown as { safeSend: typeof safeSend }).safeSend = safeSend;

    await (service as unknown as {
      sendRouterModelList: (chatId: number) => Promise<void>;
    }).sendRouterModelList(1);

    const routerKeyboard = extractKeyboard(safeSend.mock.calls[0]);
    const routerLabels = routerKeyboard.inline_keyboard.flat().map((button) => button.text);
    expect(routerLabels.join("\n")).toContain("ctcli:gpt-5-mini");
    expect(routerLabels.join("\n")).toContain("cccli:claude-haiku-4.5");
    expect(routerLabels.join("\n")).not.toContain("gmcli:gemini-3.1-pro-preview");

    safeSend.mockClear();

    await (service as unknown as {
      sendCoreModelList: (chatId: number) => Promise<void>;
    }).sendCoreModelList(1);

    const coreKeyboard = extractKeyboard(safeSend.mock.calls[0]);
    const coreLabels = coreKeyboard.inline_keyboard.flat().map((button) => button.text);
    expect(coreLabels.join("\n")).toContain("gmcli:gemini-3.1-pro-preview");
  });
});
