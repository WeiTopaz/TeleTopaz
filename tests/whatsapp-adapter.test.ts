import { describe, it, expect, vi, beforeEach } from "vitest";
import { WhatsAppAdapter } from "../src/whatsapp/adapter.js";
import type { WhatsAppClient, WaMessageKey } from "../src/whatsapp/client.js";

function makeMockClient(): WhatsAppClient {
  return {
    sendMessage: vi.fn(),
    sendPresenceUpdate: vi.fn(),
    sendReaction: vi.fn(),
  } as unknown as WhatsAppClient;
}

function makeMessageKey(id = "abc123", jid = "1234@s.whatsapp.net"): WaMessageKey {
  return { id, remoteJid: jid, fromMe: true };
}

const OWNER_JIDS = new Set(["886912345678@s.whatsapp.net", "886987654321@s.whatsapp.net"]);

describe("WhatsAppAdapter", () => {
  let client: WhatsAppClient;
  let adapter: WhatsAppAdapter;

  beforeEach(() => {
    client = makeMockClient();
    adapter = new WhatsAppAdapter(client, OWNER_JIDS);
  });

  describe("name", () => {
    it("is 'whatsapp'", () => {
      expect(adapter.name).toBe("whatsapp");
    });
  });

  describe("isOwner", () => {
    it("returns true for owner JID", () => {
      expect(adapter.isOwner("886912345678@s.whatsapp.net")).toBe(true);
    });

    it("returns false for unknown JID", () => {
      expect(adapter.isOwner("999@s.whatsapp.net")).toBe(false);
    });
  });

  describe("sendMessage", () => {
    it("calls client.sendMessage and returns encoded message key", async () => {
      const key = makeMessageKey();
      vi.mocked(client.sendMessage).mockResolvedValue(key);
      const result = await adapter.sendMessage("1234@s.whatsapp.net", "hello");
      expect(client.sendMessage).toHaveBeenCalledOnce();
      // result should be JSON-encoded WaMessageKey
      const decoded = JSON.parse(result) as WaMessageKey;
      expect(decoded.id).toBe(key.id);
      expect(decoded.remoteJid).toBe(key.remoteJid);
    });

    it("returns empty string when client returns null", async () => {
      vi.mocked(client.sendMessage).mockResolvedValue(null);
      const result = await adapter.sendMessage("1234@s.whatsapp.net", "hello");
      expect(result).toBe("");
    });
  });

  describe("editMessage", () => {
    it("is a no-op (WhatsApp does not support editing)", async () => {
      await expect(adapter.editMessage("1234@s.whatsapp.net", "msgId", "new text")).resolves.toBeUndefined();
    });
  });

  describe("sendReaction", () => {
    it("calls client.sendReaction with parsed WaMessageKey", async () => {
      vi.mocked(client.sendReaction).mockResolvedValue(undefined);
      const key = makeMessageKey();
      const messageId = JSON.stringify(key);
      await adapter.sendReaction("1234@s.whatsapp.net", messageId, "👍");
      expect(client.sendReaction).toHaveBeenCalledWith(
        "1234@s.whatsapp.net",
        key,
        "👍"
      );
    });

    it("is a no-op for invalid/empty messageId", async () => {
      await expect(adapter.sendReaction("1234@s.whatsapp.net", "", "👍")).resolves.toBeUndefined();
      expect(client.sendReaction).not.toHaveBeenCalled();
    });
  });

  describe("sendTyping", () => {
    it("calls client.sendPresenceUpdate with composing", async () => {
      vi.mocked(client.sendPresenceUpdate).mockResolvedValue(undefined);
      await adapter.sendTyping("1234@s.whatsapp.net");
      expect(client.sendPresenceUpdate).toHaveBeenCalledWith("1234@s.whatsapp.net", "composing");
    });
  });

  describe("formatMarkdown", () => {
    it("converts markdown to WhatsApp format", () => {
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
