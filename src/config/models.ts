import type { ProviderType } from "../provider/types.js";

const DEFAULT_MODEL_ENV = "TELETOPAZ_DEFAULT_MODEL";

export type CliProviderLabel = "ctcli" | "gmcli";

export type SupportedModel = {
  provider: ProviderType;
  cli: CliProviderLabel;
  model: string;
  entry: `${CliProviderLabel}:${string}`;
};

export const DEFAULT_ROUTER_MODEL = "gpt-5-mini";
export const DEFAULT_CORE_MODEL = "gemini-3.1-pro-preview";
export const DEFAULT_MODEL_ENTRY = `gmcli:${DEFAULT_CORE_MODEL}` as const;

const PROVIDER_TO_CLI: Record<ProviderType, CliProviderLabel> = {
  copilot: "ctcli",
  gemini: "gmcli"
};

const CLI_TO_PROVIDER: Record<string, ProviderType> = {
  ctcli: "copilot",
  copilot: "copilot",
  copilotcli: "copilot",
  gmcli: "gemini",
  gemini: "gemini",
  geminicli: "gemini"
};

const SUPPORTED_MODELS: SupportedModel[] = [
  { provider: "copilot", cli: "ctcli", model: "gpt-5.4", entry: "ctcli:gpt-5.4" },
  { provider: "copilot", cli: "ctcli", model: "gpt-5-mini", entry: "ctcli:gpt-5-mini" },
  { provider: "copilot", cli: "ctcli", model: "claude-opus-4.6", entry: "ctcli:claude-opus-4.6" },
  { provider: "copilot", cli: "ctcli", model: "claude-sonnet-4.6", entry: "ctcli:claude-sonnet-4.6" },
  { provider: "gemini", cli: "gmcli", model: DEFAULT_CORE_MODEL, entry: DEFAULT_MODEL_ENTRY }
];

const SUPPORTED_MODEL_ENTRIES = new Set(SUPPORTED_MODELS.map((item) => item.entry));

export function cliLabelForProvider(provider: ProviderType): CliProviderLabel {
  return PROVIDER_TO_CLI[provider];
}

export function inferProviderFromModel(model: string): ProviderType {
  return model.toLowerCase().includes("gemini") ? "gemini" : "copilot";
}

export function formatModelEntry(provider: ProviderType, model: string): `${CliProviderLabel}:${string}` {
  return `${cliLabelForProvider(provider)}:${model}`;
}

export function parseModelEntry(entry: string): {
  provider: ProviderType;
  cli: CliProviderLabel;
  model: string;
} {
  const trimmed = entry.trim();
  const separatorIndex = trimmed.indexOf(":");
  if (separatorIndex === -1) {
    const provider = inferProviderFromModel(trimmed);
    return { provider, cli: cliLabelForProvider(provider), model: trimmed };
  }

  const prefix = trimmed.slice(0, separatorIndex).trim().toLowerCase();
  const model = trimmed.slice(separatorIndex + 1).trim();
  const provider = CLI_TO_PROVIDER[prefix] ?? inferProviderFromModel(model);
  return { provider, cli: cliLabelForProvider(provider), model };
}

export function normalizeModelEntry(
  entry: string | undefined,
  fallback: string = DEFAULT_MODEL_ENTRY
): string {
  if (!entry) return fallback;
  const trimmed = entry.trim();
  if (!trimmed) return fallback;

  const parsed = parseModelEntry(trimmed);
  const normalized = formatModelEntry(parsed.provider, parsed.model);
  return SUPPORTED_MODEL_ENTRIES.has(normalized) ? normalized : fallback;
}

export async function loadSupportedModels(provider: ProviderType = "copilot"): Promise<string[]> {
  return SUPPORTED_MODELS.filter((item) => item.provider === provider).map((item) => item.model);
}

export function getAllModels(): SupportedModel[] {
  return [...SUPPORTED_MODELS];
}

export function getDefaultModel(models: string[]): string | undefined {
  if (models.includes(DEFAULT_CORE_MODEL)) return DEFAULT_CORE_MODEL;

  const override = process.env[DEFAULT_MODEL_ENV];
  if (override) {
    const parsed = parseModelEntry(override);
    if (models.includes(parsed.model)) return parsed.model;
  }

  return models[0];
}

export function getDefaultModelEnvName(): string {
  return DEFAULT_MODEL_ENV;
}
