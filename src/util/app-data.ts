import os from "node:os";
import path from "node:path";

const DEFAULT_APP_DATA_DIR = ".teletopaz";

export function resolveAppDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TELETOPAZ_DATA_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), DEFAULT_APP_DATA_DIR);
}
