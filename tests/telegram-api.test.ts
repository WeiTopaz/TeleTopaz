import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import https from "node:https";

// Inline factory: Agent must use regular function (not arrow) to be newable
vi.mock("node:https", () => ({
  default: {
    Agent: vi.fn(function Agent() {}),
    request: vi.fn(),
  },
}));

vi.mock("../src/util/tls.js", () => ({
  buildCheckServerIdentity: vi.fn().mockReturnValue(() => undefined),
  parseFingerprints: vi.fn().mockReturnValue([]),
}));

import { TelegramApi } from "../src/telegram/api.js";

const mockRequest = vi.mocked(https.request);
const MockAgent = vi.mocked(https.Agent as unknown as new (...args: any[]) => unknown);

/** Create a fake HTTPS request that triggers a JSON API response on req.end(). */
function fakeApiRequest(responseBody: object) {
  const res = new EventEmitter() as any;
  const req = new EventEmitter() as any;
  req.write = vi.fn();
  req.destroy = vi.fn((err?: Error) => { if (err) req.emit("error", err); });
  req.end = vi.fn(() => {
    queueMicrotask(() => {
      const lastCall = mockRequest.mock.calls.at(-1);
      lastCall?.[2]?.(res);
      queueMicrotask(() => {
        res.emit("data", Buffer.from(JSON.stringify(responseBody)));
        res.emit("end");
      });
    });
  });
  return req;
}

/** Create a fake download request that emits data chunks. */
function fakeDownloadRequest(chunks: Buffer[], statusCode = 200) {
  const res = new EventEmitter() as any;
  res.statusCode = statusCode;
  const req = new EventEmitter() as any;
  req.write = vi.fn();
  req.destroy = vi.fn((err?: Error) => { if (err) req.emit("error", err); });
  req.end = vi.fn(() => {
    queueMicrotask(() => {
      const lastCall = mockRequest.mock.calls.at(-1);
      lastCall?.[2]?.(res);
      queueMicrotask(() => {
        for (const chunk of chunks) res.emit("data", chunk);
        res.emit("end");
      });
    });
  });
  return req;
}

function createApi() {
  return new TelegramApi({ token: "123456:fake_token", fingerprints: [] });
}

describe("TelegramApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sendMessage returns the message from API response", async () => {
    const expected = { message_id: 42, date: 0, chat: { id: 1, type: "private" } };
    mockRequest.mockReturnValue(fakeApiRequest({ ok: true, result: expected }) as any);
    const result = await createApi().sendMessage({ chat_id: 1, text: "hello" });
    expect(result).toEqual(expected);
  });

  it("sendMessage passes parse_mode in request body", async () => {
    let body = "";
    const req = fakeApiRequest({ ok: true, result: { message_id: 1 } });
    req.write = vi.fn((data: string) => { body = data; });
    mockRequest.mockReturnValue(req as any);
    await createApi().sendMessage({ chat_id: 1, text: "hello", parse_mode: "MarkdownV2" });
    expect(JSON.parse(body)).toMatchObject({ parse_mode: "MarkdownV2" });
  });

  it("throws on non-ok API response", async () => {
    mockRequest.mockReturnValue(
      fakeApiRequest({ ok: false, description: "Bad Request: text is empty" }) as any
    );
    await expect(createApi().sendMessage({ chat_id: 1, text: "" })).rejects.toThrow("Bad Request");
  });

  it("getUpdates passes offset and timeout in payload", async () => {
    let body = "";
    const req = fakeApiRequest({ ok: true, result: [] });
    req.write = vi.fn((data: string) => { body = data; });
    mockRequest.mockReturnValue(req as any);
    await createApi().getUpdates(100, 30);
    expect(JSON.parse(body)).toMatchObject({ offset: 100, timeout: 30 });
  });

  it("editMessageText calls the editMessageText endpoint", async () => {
    let capturedUrl = "";
    mockRequest.mockImplementation((url: URL) => {
      capturedUrl = url.toString();
      return fakeApiRequest({ ok: true, result: { message_id: 5 } }) as any;
    });
    await createApi().editMessageText({ chat_id: 1, message_id: 5, text: "updated" });
    expect(capturedUrl).toContain("editMessageText");
  });

  it("editMessageTextPlain omits parse_mode from payload", async () => {
    let body = "";
    const req = fakeApiRequest({ ok: true, result: { message_id: 1 } });
    req.write = vi.fn((data: string) => { body = data; });
    mockRequest.mockReturnValue(req as any);
    await createApi().editMessageTextPlain({ chat_id: 1, message_id: 1, text: "plain" });
    expect(JSON.parse(body)).not.toHaveProperty("parse_mode");
  });

  it("answerCallbackQuery returns boolean", async () => {
    mockRequest.mockReturnValue(fakeApiRequest({ ok: true, result: true }) as any);
    const result = await createApi().answerCallbackQuery("qid_123");
    expect(result).toBe(true);
  });

  it("setMessageReaction sends correct emoji payload", async () => {
    let body = "";
    const req = fakeApiRequest({ ok: true, result: true });
    req.write = vi.fn((data: string) => { body = data; });
    mockRequest.mockReturnValue(req as any);
    await createApi().setMessageReaction({
      chat_id: 1,
      message_id: 5,
      reaction: [{ type: "emoji", emoji: "👍" }],
    });
    expect(JSON.parse(body).reaction).toEqual([{ type: "emoji", emoji: "👍" }]);
  });

  it("getFile returns file metadata", async () => {
    const fileData = { file_id: "f1", file_size: 1024, file_path: "photos/file.jpg" };
    mockRequest.mockReturnValue(fakeApiRequest({ ok: true, result: fileData }) as any);
    const result = await createApi().getFile("f1");
    expect(result).toEqual(fileData);
  });

  it("getChat returns chat info", async () => {
    const chatData = { id: 1, type: "private", first_name: "Test" };
    mockRequest.mockReturnValue(fakeApiRequest({ ok: true, result: chatData }) as any);
    const result = await createApi().getChat(1);
    expect(result).toEqual(chatData);
  });

  it("downloadFile returns concatenated buffer on success", async () => {
    const data = Buffer.from("image-data");
    mockRequest.mockReturnValue(fakeDownloadRequest([data]) as any);
    const result = await createApi().downloadFile("photos/file.jpg", 1024 * 1024);
    expect(result).toEqual(data);
  });

  it("downloadFile enforces maxBytes limit and rejects oversized downloads", async () => {
    const bigChunk = Buffer.alloc(100, "x");
    mockRequest.mockReturnValue(fakeDownloadRequest([bigChunk]) as any);
    await expect(createApi().downloadFile("photos/file.jpg", 50)).rejects.toThrow("size limit");
  });

  it("applies TLS certificate pinning via Agent constructor", () => {
    new TelegramApi({ token: "123456:tok", fingerprints: ["AABBCCDD"] });
    expect(MockAgent).toHaveBeenCalledWith(
      expect.objectContaining({ checkServerIdentity: expect.any(Function) })
    );
  });
});
