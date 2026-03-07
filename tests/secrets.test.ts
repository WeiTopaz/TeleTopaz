import { describe, expect, it, vi } from "vitest";
import { loadSecrets } from "../src/config/secrets.js";

describe("loadSecrets", () => {
  it("reads only required secrets from keychain and takes optional startup settings from runtime config", async () => {
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
        directoryPatterns: "/Users/test/Project/*",
        certificateFingerprints: "sha256/runtime"
      }
    });

    expect(secrets).toEqual({
      botToken: "telegram-token",
      ownerChatId: "123",
      ownerUserId: "456",
      directoryPatterns: "/Users/test/Project/*",
      certificateFingerprints: "sha256/runtime"
    });
    expect(getPassword).toHaveBeenCalledTimes(3);
    expect(getPassword).not.toHaveBeenCalledWith("teletopaz", "directory_patterns");
    expect(getPassword).not.toHaveBeenCalledWith("teletopaz", "certificate_fingerprints");
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
        directoryPatterns: undefined,
        certificateFingerprints: undefined
      }
    });

    expect(secrets.botToken).toBe("env-token");
    expect(secrets.ownerChatId).toBe("42");
    expect(secrets.ownerUserId).toBe("99");
    expect(getPassword).not.toHaveBeenCalled();
  });
});
