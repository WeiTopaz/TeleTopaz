import keytar from "keytar";
import { loadRuntimeConfig, type RuntimeConfig } from "./runtime-config.js";

export type SecretKeys = {
  botToken: string;
  ownerChatId: string;
  ownerUserId: string;
  directoryPatterns: string | undefined;
  certificateFingerprints: string | undefined;
};

const SERVICE_NAME = "teletopaz";
const KEY_BOT_TOKEN = "bot_token";
const KEY_OWNER_CHAT_ID = "owner_chat_id";
const KEY_OWNER_USER_ID = "owner_user_id";
const KEY_DIR_PATTERNS = "directory_patterns";
const KEY_CERT_FINGERPRINTS = "certificate_fingerprints";

type KeytarLike = Pick<typeof keytar, "getPassword" | "setPassword">;

type LoadSecretsOptions = {
  env?: NodeJS.ProcessEnv | undefined;
  keytar?: Pick<KeytarLike, "getPassword"> | undefined;
  runtimeConfig?: RuntimeConfig | undefined;
};

type RequiredSecretKey = "botToken" | "ownerChatId" | "ownerUserId";

const REQUIRED_SECRET_ENV_KEYS: Record<RequiredSecretKey, keyof NodeJS.ProcessEnv> = {
  botToken: "TELETOPAZ_BOT_TOKEN",
  ownerChatId: "TELETOPAZ_OWNER_CHAT_ID",
  ownerUserId: "TELETOPAZ_OWNER_USER_ID"
};

const REQUIRED_SECRET_KEYCHAIN_KEYS: Record<RequiredSecretKey, string> = {
  botToken: KEY_BOT_TOKEN,
  ownerChatId: KEY_OWNER_CHAT_ID,
  ownerUserId: KEY_OWNER_USER_ID
};

function coerceOptionalString(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function loadRequiredSecret(
  key: RequiredSecretKey,
  env: NodeJS.ProcessEnv,
  keytarLike: Pick<KeytarLike, "getPassword">
): Promise<string | undefined> {
  const envValue = coerceOptionalString(env[REQUIRED_SECRET_ENV_KEYS[key]]);
  if (envValue) return envValue;
  return coerceOptionalString(await keytarLike.getPassword(SERVICE_NAME, REQUIRED_SECRET_KEYCHAIN_KEYS[key]));
}

export async function loadConfiguredRuntimeConfig(
  options: Pick<LoadSecretsOptions, "env" | "keytar" | "runtimeConfig"> = {}
): Promise<RuntimeConfig> {
  if (options.runtimeConfig) {
    return options.runtimeConfig;
  }

  const env = options.env ?? process.env;
  const keytarLike = options.keytar ?? keytar;

  // directoryPatterns: 優先環境變數，其次 keychain（主要來源，不存於檔案）
  const keychainDirectoryPatterns = coerceOptionalString(
    await keytarLike.getPassword(SERVICE_NAME, KEY_DIR_PATTERNS)
  );
  const directoryPatterns = coerceOptionalString(env.TELETOPAZ_DIRECTORY_PATTERNS) ?? keychainDirectoryPatterns;

  // certificateFingerprints: 從 runtime-config.json 取（含環境變數覆寫）
  const fileConfig = await loadRuntimeConfig({ env });

  return {
    directoryPatterns,
    certificateFingerprints: fileConfig.certificateFingerprints
  };
}

export async function saveDirectoryPatterns(
  value: string | undefined,
  keytarLike: Pick<KeytarLike, "setPassword"> = keytar
): Promise<void> {
  const normalized = coerceOptionalString(value);
  if (!normalized) return;
  await keytarLike.setPassword(SERVICE_NAME, KEY_DIR_PATTERNS, normalized);
}

export async function loadSecrets(options: LoadSecretsOptions = {}): Promise<SecretKeys> {
  const env = options.env ?? process.env;
  const keytarLike = options.keytar ?? keytar;
  const runtimeConfig = await loadConfiguredRuntimeConfig({
    env,
    keytar: keytarLike,
    runtimeConfig: options.runtimeConfig
  });

  const botToken = await loadRequiredSecret("botToken", env, keytarLike);
  const ownerChatId = await loadRequiredSecret("ownerChatId", env, keytarLike);
  const ownerUserId = await loadRequiredSecret("ownerUserId", env, keytarLike);

  if (!botToken || !ownerChatId || !ownerUserId) {
    throw new Error("缺少必要的 Telegram 設定值；請先執行 setup:secrets 或設定環境變數。");
  }

  return {
    botToken,
    ownerChatId,
    ownerUserId,
    directoryPatterns: runtimeConfig.directoryPatterns,
    certificateFingerprints: runtimeConfig.certificateFingerprints
  };
}

export async function saveSecret(key: RequiredSecretKey, value: string): Promise<void> {
  const map: Record<RequiredSecretKey, string> = {
    botToken: KEY_BOT_TOKEN,
    ownerChatId: KEY_OWNER_CHAT_ID,
    ownerUserId: KEY_OWNER_USER_ID
  };

  const normalizedValue = coerceOptionalString(value);
  if (!normalizedValue) {
    throw new Error(`${key} cannot be empty`);
  }

  await keytar.setPassword(SERVICE_NAME, map[key], normalizedValue);
}

export function getSecretServiceName(): string {
  return SERVICE_NAME;
}
