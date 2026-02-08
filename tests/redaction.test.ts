import { describe, it, expect } from "vitest";
import { redact, redactStrict } from "../src/util/redaction.js";

describe("redact", () => {
  it("redacts tokens and keys", () => {
    const input = "sk-1234567890abcdef ghp_abcdefghijklmnopqrstuvwxyz0123 123456:abcdefghijklmnopqrstuv";
    const output = redact(input);
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("sk-1234567890abcdef");
  });

  it("redacts pem blocks", () => {
    const input = "-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----";
    expect(redact(input)).toBe("[REDACTED]");
  });

  it("redacts jwt and slack tokens", () => {
    const input = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdef.ghijkl xoxb-1234567890-abcdef";
    const output = redact(input);
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("xoxb-1234567890-abcdef");
  });

  it("redacts emails only in strict mode", () => {
    const input = "contact me at test@example.com";
    expect(redact(input)).toContain("test@example.com");
    expect(redactStrict(input)).not.toContain("test@example.com");
  });
});
