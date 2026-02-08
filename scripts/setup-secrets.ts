import readline from "node:readline";
import { saveSecret } from "../src/config/secrets.js";

const ENV_KEYS = {
  botToken: "TELETOPAZ_BOT_TOKEN",
  ownerChatId: "TELETOPAZ_OWNER_CHAT_ID",
  ownerUserId: "TELETOPAZ_OWNER_USER_ID",
  directoryPatterns: "TELETOPAZ_DIRECTORY_PATTERNS",
  certificateFingerprints: "TELETOPAZ_CERT_FINGERPRINTS"
} as const;

type SecretKey = keyof typeof ENV_KEYS;

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function getValue(key: SecretKey, required: boolean): Promise<string> {
  const envKey = ENV_KEYS[key];
  const envValue = process.env[envKey];
  if (envValue && envValue.trim()) {
    return envValue.trim();
  }

  const label = envKey.replace("TELETOPAZ_", "").toLowerCase();
  const prompt = `${label}${required ? " (required)" : " (optional)"}: `;
  const answer = (await ask(prompt)).trim();
  if (required && !answer) {
    throw new Error(`${label} cannot be empty`);
  }
  return answer;
}

async function main(): Promise<void> {
  const botToken = await getValue("botToken", true);
  const ownerChatId = await getValue("ownerChatId", true);
  const ownerUserId = await getValue("ownerUserId", true);
  const directoryPatterns = await getValue("directoryPatterns", false);
  const certificateFingerprints = await getValue("certificateFingerprints", false);

  await saveSecret("botToken", botToken);
  await saveSecret("ownerChatId", ownerChatId);
  await saveSecret("ownerUserId", ownerUserId);
  if (directoryPatterns) await saveSecret("directoryPatterns", directoryPatterns);
  if (certificateFingerprints) await saveSecret("certificateFingerprints", certificateFingerprints);

  console.log("Secrets stored in keychain.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
