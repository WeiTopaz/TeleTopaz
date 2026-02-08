import keytar from "keytar";

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

export async function loadSecrets(): Promise<SecretKeys> {
  const botToken = (await keytar.getPassword(SERVICE_NAME, KEY_BOT_TOKEN)) ?? "";
  const ownerChatId = (await keytar.getPassword(SERVICE_NAME, KEY_OWNER_CHAT_ID)) ?? "";
  const ownerUserId = (await keytar.getPassword(SERVICE_NAME, KEY_OWNER_USER_ID)) ?? "";
  const directoryPatterns = await keytar.getPassword(SERVICE_NAME, KEY_DIR_PATTERNS);
  const certificateFingerprints = await keytar.getPassword(SERVICE_NAME, KEY_CERT_FINGERPRINTS);

  if (!botToken.trim() || !ownerChatId.trim() || !ownerUserId.trim()) {
    throw new Error("缺少必要的鑰匙圈設定值");
  }

  return {
    botToken: botToken.trim(),
    ownerChatId: ownerChatId.trim(),
    ownerUserId: ownerUserId.trim(),
    directoryPatterns: directoryPatterns?.trim() || undefined,
    certificateFingerprints: certificateFingerprints?.trim() || undefined
  };
}

export async function saveSecret(key: keyof SecretKeys, value: string): Promise<void> {
  const map: Record<keyof SecretKeys, string> = {
    botToken: KEY_BOT_TOKEN,
    ownerChatId: KEY_OWNER_CHAT_ID,
    ownerUserId: KEY_OWNER_USER_ID,
    directoryPatterns: KEY_DIR_PATTERNS,
    certificateFingerprints: KEY_CERT_FINGERPRINTS
  };

  await keytar.setPassword(SERVICE_NAME, map[key], value);
}

export function getSecretServiceName(): string {
  return SERVICE_NAME;
}
