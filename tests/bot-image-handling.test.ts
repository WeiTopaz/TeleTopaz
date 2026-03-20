import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockToBuffer, mockJpeg, mockRotate, mockSharp } = vi.hoisted(() => {
  const mockToBuffer = vi.fn().mockResolvedValue(Buffer.from("re-encoded"));
  const mockJpeg = vi.fn().mockReturnValue({ toBuffer: mockToBuffer });
  const mockRotate = vi.fn().mockReturnValue({ jpeg: mockJpeg });
  const mockSharp = vi.fn().mockReturnValue({ rotate: mockRotate });
  return { mockToBuffer, mockJpeg, mockRotate, mockSharp };
});

vi.mock("sharp", () => ({ default: mockSharp }));

import { TeleTopazService } from "../src/bot.js";
import type { TelegramApi } from "../src/telegram/api.js";
import type { TelegramMessage } from "../src/telegram/types.js";

function createApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    editMessageText: vi.fn().mockResolvedValue({}),
    editMessageTextPlain: vi.fn().mockResolvedValue({}),
    getChat: vi.fn(),
    setMessageReaction: vi.fn(),
    getUpdates: vi.fn(),
    getFile: vi.fn().mockResolvedValue({ file_id: "f1", file_path: "photos/img.jpg", file_size: 1024 }),
    answerCallbackQuery: vi.fn(),
    downloadFile: vi.fn().mockResolvedValue(Buffer.from("fake-image-data")),
  } as unknown as TelegramApi;
}

function makePhotoMessage(chatId = 1): TelegramMessage {
  return {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: "private" as const },
    from: { id: 1, first_name: "Test", is_bot: false },
    photo: [
      { file_id: "small_f1", file_unique_id: "u1", width: 100, height: 100, file_size: 512 },
      { file_id: "large_f1", file_unique_id: "u2", width: 800, height: 600, file_size: 1024 },
    ],
  };
}

function createService() {
  const api = createApi();
  const service = new TeleTopazService(api, "1", "1", 0);
  (service as any).safeSend = vi.fn().mockResolvedValue({ message_id: 2 });
  return { service, api };
}

describe("image handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockToBuffer.mockResolvedValue(Buffer.from("re-encoded"));
    mockJpeg.mockReturnValue({ toBuffer: mockToBuffer });
    mockRotate.mockReturnValue({ jpeg: mockJpeg });
    mockSharp.mockReturnValue({ rotate: mockRotate });
  });

  it("downloads and re-encodes photo as JPEG, stores as base64 data URL", async () => {
    const { service, api } = createService();
    vi.mocked(api.getFile).mockResolvedValue({
      file_id: "f1", file_path: "photos/img.jpg", file_size: 1024,
    } as any);
    vi.mocked(api.downloadFile).mockResolvedValue(Buffer.from("raw-photo-data"));

    const state = (service as any).getOrCreateState(1);
    const msg = makePhotoMessage();
    const result = await (service as any).handleImages(msg, state);

    expect(result).toBe(true);
    expect(state.attachments).toHaveLength(1);
    expect(state.attachments[0].dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(mockSharp).toHaveBeenCalled();
  });

  it("rejects photo exceeding MAX_ATTACHMENT_BYTES (8MB file_size)", async () => {
    const { service, api } = createService();
    const overLimit = 9 * 1024 * 1024;
    vi.mocked(api.getFile).mockResolvedValue({
      file_id: "f1", file_path: "photos/big.jpg", file_size: overLimit,
    } as any);

    const state = (service as any).getOrCreateState(1);
    const result = await (service as any).handleImages(makePhotoMessage(), state);

    expect(result).toBe(false);
    expect(state.attachments).toHaveLength(0);
    expect((service as any).safeSend).toHaveBeenCalledWith(
      1, expect.stringContaining("超過限制"), expect.anything()
    );
  });

  it("enforces MAX_ATTACHMENTS limit (8 images)", async () => {
    const { service } = createService();
    const state = (service as any).getOrCreateState(1);

    for (let i = 0; i < 8; i++) {
      state.attachments.push({ dataUrl: `data:image/jpeg;base64,${i}`, mime: "image/jpeg", addedAt: Date.now() });
    }

    const result = await (service as any).handleImages(makePhotoMessage(), state);
    expect(result).toBe(false);
    expect((service as any).safeSend).toHaveBeenCalledWith(
      1, expect.stringContaining("已達上限"), expect.anything()
    );
  });

  it("returns false when file_path is missing", async () => {
    const { service, api } = createService();
    vi.mocked(api.getFile).mockResolvedValue({ file_id: "f1" } as any);

    const state = (service as any).getOrCreateState(1);
    const result = await (service as any).handleImages(makePhotoMessage(), state);

    expect(result).toBe(false);
  });

  it("handles re-encode failure gracefully", async () => {
    const { service, api } = createService();
    vi.mocked(api.getFile).mockResolvedValue({ file_id: "f1", file_path: "photos/bad.jpg" } as any);
    vi.mocked(api.downloadFile).mockResolvedValue(Buffer.from("corrupt-data"));
    mockToBuffer.mockRejectedValue(new Error("sharp error"));

    const state = (service as any).getOrCreateState(1);
    const result = await (service as any).handleImages(makePhotoMessage(), state);

    expect(result).toBe(false);
    expect((service as any).safeSend).toHaveBeenCalledWith(
      1, expect.stringContaining("圖片轉檔失敗"), expect.anything()
    );
  });

  it("returns false when message has no photo and no document", async () => {
    const { service } = createService();
    const state = (service as any).getOrCreateState(1);
    const msg: TelegramMessage = {
      message_id: 1,
      date: 0,
      chat: { id: 1, type: "private" as const },
      text: "no attachment",
    };
    const result = await (service as any).handleImages(msg, state);
    expect(result).toBe(false);
  });
});
