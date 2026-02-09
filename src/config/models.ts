import { CopilotSdkClient } from "../copilot/sdk.js";
import { GeminiSdkClient } from "../gemini/sdk.js";
import type { ProviderType } from "../provider/types.js";

const DEFAULT_MODEL_ENV = "TELETOPAZ_DEFAULT_MODEL";

export async function loadSupportedModels(provider: ProviderType = "copilot"): Promise<string[]> {
  if (provider === "gemini") {
    return loadGeminiModels();
  }
  return loadCopilotModels();
}

async function loadCopilotModels(): Promise<string[]> {
  const client = new CopilotSdkClient();
  try {
    await client.start();
    const info = await client.queryProviderInfo();
    return info.models ?? [];
  } catch {
    return [];
  } finally {
    await client.stop().catch(() => undefined);
  }
}

async function loadGeminiModels(): Promise<string[]> {
  const client = new GeminiSdkClient();
  try {
    await client.start();
    const info = await client.queryProviderInfo();
    return info.models ?? [];
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
