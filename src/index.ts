import { TeleTopazService } from "./bot.js";
import { ensureSandbox } from "./sandbox.js";
import { logger } from "./util/logger.js";

async function main(): Promise<void> {
  await ensureSandbox();
  const bot = await TeleTopazService.create();
  await bot.start();
}

main().catch(async (err) => {
  logger.error("啟動失敗", err);
  await logger.flush();
  process.exit(1);
});
