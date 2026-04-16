import { describe, expect, it, vi } from "vitest";
import { loadSecrets, loadConfiguredRuntimeConfig } from "../src/config/secrets.js";

describe("loadSecrets", () => {
  it("uses injected runtimeConfig directly without reading keychain for directory patterns", async () => {
    const getPassword = vi.fn(async (_service: string, account: string) => {
      switch (account) {
        case "bot_token":
          return "telegram-token";
        case "owner_chat_id":
          return "123";
        case "owner_user_id":
          return "456";
        default:
          return "unexpected";
      }
    });

    const secrets = await loadSecrets({
      env: {},
      keytar: { getPassword },
      runtimeConfig: {
        directoryPatterns: "/Users/test/Project/*"
      }
    });

    expect(secrets).toEqual({
      botToken: "telegram-token",
      ownerChatId: "123",
      ownerUserId: "456",
      directoryPatterns: "/Users/test/Project/*"
    });
    // runtimeConfig 直接注入時，keychain 僅被呼叫 3 次（三個必要 secrets）
    expect(getPassword).toHaveBeenCalledTimes(3);
  });

  it("prefers environment variables before keychain for required secrets", async () => {
    const getPassword = vi.fn();

    const secrets = await loadSecrets({
      env: {
        TELETOPAZ_BOT_TOKEN: "env-token",
        TELETOPAZ_OWNER_CHAT_ID: "42",
        TELETOPAZ_OWNER_USER_ID: "99"
      } as NodeJS.ProcessEnv,
      keytar: { getPassword },
      runtimeConfig: {
        directoryPatterns: undefined
      }
    });

    expect(secrets.botToken).toBe("env-token");
    expect(secrets.ownerChatId).toBe("42");
    expect(secrets.ownerUserId).toBe("99");
    expect(getPassword).not.toHaveBeenCalled();
  });
});

describe("loadConfiguredRuntimeConfig", () => {
  it("reads directoryPatterns from keychain as primary source", async () => {
    const getPassword = vi.fn(async (_service: string, account: string) => {
      if (account === "directory_patterns") return "/Users/test/Keychain/*";
      return null;
    });

    const config = await loadConfiguredRuntimeConfig({
      env: {} as NodeJS.ProcessEnv,
      keytar: { getPassword },
      runtimeConfig: undefined
    });

    expect(config.directoryPatterns).toBe("/Users/test/Keychain/*");
    expect(getPassword).toHaveBeenCalledWith("teletopaz", "directory_patterns");
  });

  it("prefers TELETOPAZ_DIRECTORY_PATTERNS env var over keychain", async () => {
    const getPassword = vi.fn(async (_service: string, account: string) => {
      if (account === "directory_patterns") return "/Users/test/Keychain/*";
      return null;
    });

    const config = await loadConfiguredRuntimeConfig({
      env: { TELETOPAZ_DIRECTORY_PATTERNS: "/Users/test/Env/*" } as NodeJS.ProcessEnv,
      keytar: { getPassword },
      runtimeConfig: undefined
    });

    expect(config.directoryPatterns).toBe("/Users/test/Env/*");
  });
});
