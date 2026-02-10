import type { ProviderType } from "../provider/types.js";

const DEFAULT_MODEL_ENV = "TELETOPAZ_DEFAULT_MODEL";

const ALLOWED_MODELS: Record<ProviderType, string[]> = {
  copilot: ["gpt-5-mini", "gpt-5.2-codex", "claude-opus-4.6"],
  gemini: ["gemini-3-pro-preview", "gemini-3-flash-preview"]
};

export async function loadSupportedModels(provider: ProviderType = "copilot"): Promise<string[]> {
  return ALLOWED_MODELS[provider] || [];
}

export function getAllModels(): { provider: ProviderType; model: string }[] {
  const result: { provider: ProviderType; model: string }[] = [];
  // Sort providers to keep order consistent: Gemini first (as per Core default), or Copilot?
  // User listed "GeminiCLI:..." then "CopilotCLI:...". Let's sort alphabetically or specific order.
  // User: "GeminiCLI:gemini-3-pro-preview", "CopilotCLI:gpt-5.2-codex"
  // Let's do Gemini then Copilot or vice versa. 
  // Let's stick to the key order in ALLOWED_MODELS object or explicit.
  
  // Gemini
  ALLOWED_MODELS.gemini.forEach(m => result.push({ provider: "gemini", model: m }));
  // Copilot
  ALLOWED_MODELS.copilot.forEach(m => result.push({ provider: "copilot", model: m }));
  
  return result;
}

export function getDefaultModel(models: string[]): string | undefined {
  // Return gemini-3-pro-preview if present (Core default), else gpt-5-mini (Router default) or first
  if (models.includes("gemini-3-pro-preview")) return "gemini-3-pro-preview";
  const override = process.env[DEFAULT_MODEL_ENV];
  if (override && models.includes(override)) return override;
  return models[0];
}

export function getDefaultModelEnvName(): string {
  return DEFAULT_MODEL_ENV;
}