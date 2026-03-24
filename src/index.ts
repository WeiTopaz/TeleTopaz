import { TeleTopazService } from "./bot.js";
import { WhatsAppService } from "./whatsapp/service.js";
import { ensureSandbox } from "./sandbox.js";
import { logger } from "./util/logger.js";

async function main(): Promise<void> {
  await ensureSandbox();
  const [bot, wa] = await Promise.all([
    TeleTopazService.create(),
    WhatsAppService.create(),
  ]);
  if (wa) {
    process.on("SIGTERM", () => void wa.stop());
    await wa.start().catch((err: unknown) => logger.error("WhatsApp 啟動失敗", err));
  }
  await bot.start();
}

main().catch(async (err) => {
  logger.error("啟動失敗", err);
  await logger.flush();
  process.exit(1);
});
