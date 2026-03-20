import { describe, it, expect, vi, afterEach } from "vitest";
import { TeleTopazService } from "../src/bot.js";
import type { AiClient, AiSession } from "../src/provider/types.js";
import type { TelegramApi } from "../src/telegram/api.js";

function createApi(): TelegramApi {
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

function createSessionMock(): AiSession {
  return {
    onEvent: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    sendAndWait: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
  };
}

function createClientMock(): AiClient {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn(),
    queryProviderInfo: vi.fn().mockResolvedValue({}),
  };
}

describe("shutdown", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    exitSpy?.mockRestore();
  });

  it("calls destroy on active sessions", async () => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(vi.fn() as any);

    const api = createApi();
    const session = createSessionMock();
    const client = createClientMock();
    const service = new TeleTopazService(api, "1", "1", 0);

    const state = (service as any).getOrCreateState(1);
    state.session = session;
    state.client = client;

    await service.shutdown();

    expect(session.destroy).toHaveBeenCalled();
  });

  it("calls stop on active clients", async () => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(vi.fn() as any);

    const api = createApi();
    const session = createSessionMock();
    const client = createClientMock();
    const service = new TeleTopazService(api, "1", "1", 0);

    const state = (service as any).getOrCreateState(1);
    state.session = session;
    state.client = client;

    await service.shutdown();

    expect(client.stop).toHaveBeenCalled();
  });

  it("calls process.exit(0) after cleanup", async () => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(vi.fn() as any);

    const service = new TeleTopazService(createApi(), "1", "1", 0);
    await service.shutdown();

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("does not run twice if called concurrently (idempotent)", async () => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(vi.fn() as any);

    const session = createSessionMock();
    const service = new TeleTopazService(createApi(), "1", "1", 0);
    const state = (service as any).getOrCreateState(1);
    state.session = session;

    await Promise.all([service.shutdown(), service.shutdown()]);

    // destroy should only be called once
    expect(session.destroy).toHaveBeenCalledTimes(1);
  });
});
