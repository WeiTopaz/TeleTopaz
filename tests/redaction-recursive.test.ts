import { describe, it, expect } from "vitest";
import { redactUnknown, redactObject, getRedactionPlaceholder } from "../src/util/redaction.js";

const REDACTED = getRedactionPlaceholder();

describe("redactUnknown", () => {
  it("redacts string values", () => {
    const result = redactUnknown("my token: sk-1234567890abcdef1234567890abcdef");
    expect(result).not.toContain("sk-1234567890abcdef");
    expect(result).toContain(REDACTED);
  });

  it("returns non-string primitives unchanged", () => {
    expect(redactUnknown(42)).toBe(42);
    expect(redactUnknown(true)).toBe(true);
    expect(redactUnknown(null)).toBeNull();
    expect(redactUnknown(undefined)).toBeUndefined();
  });

  it("redacts Error message and stack", () => {
    const original = new Error("token sk-1234567890abcdef1234567890abcdef leaked");
    const result = redactUnknown(original) as Error;
    expect(result).toBeInstanceOf(Error);
    expect(result.message).not.toContain("sk-1234567890abcdef");
    expect(result.message).toContain(REDACTED);
  });

  it("preserves Error instance type after redaction", () => {
    const original = new Error("clean message");
    const result = redactUnknown(original) as Error;
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("clean message");
  });

  it("redacts sensitive values in arrays recursively", () => {
    const input = ["normal text", "sk-1234567890abcdef1234567890abcdef", 42];
    const result = redactUnknown(input) as string[];
    expect(result[0]).toBe("normal text");
    expect(result[1]).not.toContain("sk-1234567890abcdef");
    expect(result[1]).toContain(REDACTED);
    expect(result[2]).toBe(42);
  });

  it("redacts sensitive values in nested objects", () => {
    const input = {
      message: "hello",
      credentials: { token: "sk-1234567890abcdef1234567890abcdef" },
    };
    const result = redactUnknown(input) as typeof input;
    expect(result.message).toBe("hello");
    expect((result.credentials as any).token).not.toContain("sk-1234567890abcdef");
    expect((result.credentials as any).token).toContain(REDACTED);
  });

  it("handles deeply nested objects", () => {
    const input = {
      level1: {
        level2: {
          level3: { secret: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.fake" },
        },
      },
    };
    const result = redactUnknown(input) as any;
    // Bearer tokens are in strict patterns, not base patterns, so the JWT portion will be redacted
    const secret = result.level1.level2.level3.secret as string;
    // JWT pattern should be redacted
    expect(secret).not.toContain("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0");
  });

  it("handles arrays of objects", () => {
    const input = [
      { name: "Alice", key: "AKIA1234567890ABCDEF" },
      { name: "Bob", key: "safe-value" },
    ];
    const result = redactUnknown(input) as Array<{ name: string; key: string }>;
    expect(result[0]!.name).toBe("Alice");
    expect(result[0]!.key).not.toContain("AKIA");
    expect(result[0]!.key).toContain(REDACTED);
    expect(result[1]!.key).toBe("safe-value");
  });
});

describe("redactObject", () => {
  it("redacts all string values in a flat object", () => {
    const input = {
      normal: "hello",
      secret: "sk-1234567890abcdef1234567890abcdef",
    };
    const result = redactObject(input);
    expect(result.normal).toBe("hello");
    expect(result.secret).not.toContain("sk-1234567890");
    expect(result.secret).toContain(REDACTED);
  });

  it("does not mutate the original object", () => {
    const input = { value: "sk-1234567890abcdef1234567890abcdef" };
    const result = redactObject(input);
    expect(input.value).toContain("sk-1234");
    expect(result.value).toContain(REDACTED);
  });

  it("handles empty object", () => {
    expect(redactObject({})).toEqual({});
  });

  it("handles nested objects recursively", () => {
    const input = {
      outer: {
        inner: "ghp_abcdefghijklmnopqrstuvwxyz01234",
      },
    };
    const result = redactObject(input);
    expect((result.outer as any).inner).toContain(REDACTED);
  });
});
