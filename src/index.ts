import { TeleTopazService } from "./bot.js";
// [DISABLED] WhatsApp 管道暫時關閉，保留程式碼供日後啟用
// import { WhatsAppService } from "./whatsapp/service.js";
import { ensureSandbox } from "./sandbox.js";
import { logger } from "./util/logger.js";

async function main(): Promise<void> {
  await ensureSandbox();
  const bot = await TeleTopazService.create();
  // [DISABLED] WhatsApp 管道暫時關閉，取消註解即可重新啟用
  // const wa = await WhatsAppService.create();
  // if (wa) {
  //   process.on("SIGTERM", () => void wa.stop());
  //   await wa.start().catch((err: unknown) => logger.error("WhatsApp 啟動失敗", err));
  // }
  await bot.start();
}

main().catch(async (err) => {
  logger.error("啟動失敗", err);
  await logger.flush();
  process.exit(1);
});
