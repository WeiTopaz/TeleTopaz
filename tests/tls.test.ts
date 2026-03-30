import { describe, it, expect, vi } from "vitest";
import type tls from "node:tls";

// Mock node:tls so checkServerIdentity always passes for fake test certs
vi.mock("node:tls", () => ({
  default: { checkServerIdentity: vi.fn().mockReturnValue(undefined) },
  checkServerIdentity: vi.fn().mockReturnValue(undefined),
}));

import { normalizeFingerprint, parseFingerprints, buildCheckServerIdentity } from "../src/util/tls.js";

function makeCert(fingerprint256: string): tls.PeerCertificate {
  return { fingerprint256, raw: Buffer.from("fake-cert-data") } as unknown as tls.PeerCertificate;
}

describe("TLS utilities", () => {
  describe("normalizeFingerprint", () => {
    it("removes non-hex characters and uppercases", () => {
      expect(normalizeFingerprint("ab:cd:ef")).toBe("ABCDEF");
      expect(normalizeFingerprint("AB-CD-EF")).toBe("ABCDEF");
      expect(normalizeFingerprint("aa bb cc")).toBe("AABBCC");
    });

    it("handles empty string", () => {
      expect(normalizeFingerprint("")).toBe("");
    });

    it("strips colons from SHA256 fingerprint format", () => {
      const fp = "AA:BB:CC:DD:EE:FF";
      expect(normalizeFingerprint(fp)).toBe("AABBCCDDEEFF");
    });
  });

  describe("parseFingerprints", () => {
    it("splits comma-separated fingerprints", () => {
      const result = parseFingerprints("AA:BB,CC:DD");
      expect(result).toEqual(["AABB", "CCDD"]);
    });

    it("returns empty array for undefined", () => {
      expect(parseFingerprints(undefined)).toEqual([]);
    });

    it("returns empty array for empty string", () => {
      expect(parseFingerprints("")).toEqual([]);
    });

    it("normalizes each fingerprint entry", () => {
      expect(parseFingerprints("aa:bb:cc,DD:EE:FF")).toEqual(["AABBCC", "DDEEFF"]);
    });
  });

  describe("buildCheckServerIdentity", () => {
    it("rejects wrong hostname", () => {
      const check = buildCheckServerIdentity("api.telegram.org", []);
      const result = check("wrong.host.com", makeCert("AA:BB"));
      expect(result).toBeInstanceOf(Error);
      expect(result?.message).toContain("Unexpected host");
    });

    it("accepts connection when no fingerprints are configured", () => {
      const check = buildCheckServerIdentity("api.telegram.org", []);
      // tls.checkServerIdentity is mocked to return undefined (pass)
      const result = check("api.telegram.org", makeCert("AA:BB:CC"));
      expect(result).toBeUndefined();
    });

    it("accepts connection with matching fingerprint", () => {
      const rawFp = "AA:BB:CC:DD";
      const normalized = normalizeFingerprint(rawFp);
      const check = buildCheckServerIdentity("api.telegram.org", [normalized]);
      const result = check("api.telegram.org", makeCert(rawFp));
      expect(result).toBeUndefined();
    });

    it("rejects connection with non-matching fingerprint", () => {
      const check = buildCheckServerIdentity("api.telegram.org", ["AABBCCDD"]);
      const result = check("api.telegram.org", makeCert("EE:FF:00:11"));
      expect(result).toBeInstanceOf(Error);
      expect(result?.message).toContain("fingerprint");
    });

    it("accepts one of multiple allowed fingerprints", () => {
      const check = buildCheckServerIdentity("api.telegram.org", ["AABBCCDD", "EEFF0011"]);
      const result = check("api.telegram.org", makeCert("EE:FF:00:11"));
      expect(result).toBeUndefined();
    });
  });
});
