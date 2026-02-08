import { CopilotSdkClient } from "../copilot/sdk.js";

const DEFAULT_MODEL_ENV = "TELETOPAZ_DEFAULT_MODEL";

export async function loadSupportedModels(): Promise<string[]> {
  const client = new CopilotSdkClient();
  try {
    await client.start();
    const info = await client.queryProviderInfo();
    const models = info.models ?? [];
    return models;
  } catch {
    return [];
  } finally {
    await client.stop().catch(() => undefined);
  }
}

export function getDefaultModel(models: string[]): string | undefined {
  const override = process.env[DEFAULT_MODEL_ENV];
  if (override && models.includes(override)) return override;
  if (models.includes("gpt-5-mini")) return "gpt-5-mini";
  return models[0];
}

export function getDefaultModelEnvName(): string {
  return DEFAULT_MODEL_ENV;
}
