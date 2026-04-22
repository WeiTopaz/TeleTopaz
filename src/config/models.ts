import type { ProviderType } from "../provider/types.js";

const DEFAULT_MODEL_ENV = "TELETOPAZ_DEFAULT_MODEL";

export type CliProviderLabel = "ctcli" | "gmcli" | "cccli" | "cdcli";

export type SupportedModel = {
  provider: ProviderType;
  cli: CliProviderLabel;
  model: string;
  entry: `${CliProviderLabel}:${string}`;
};

const DEFAULT_ROUTER_MODEL_NAME = "gpt-5.4-mini";
const DEFAULT_CORE_MODEL_NAME = "gpt-5.4";

export const DEFAULT_ROUTER_MODEL = `cdcli:${DEFAULT_ROUTER_MODEL_NAME}` as const;
export const DEFAULT_CORE_MODEL = `cdcli:${DEFAULT_CORE_MODEL_NAME}` as const;
export const DEFAULT_MODEL_ENTRY = DEFAULT_CORE_MODEL;

const PROVIDER_TO_CLI: Record<ProviderType, CliProviderLabel> = {
  copilot: "ctcli",
  gemini: "gmcli",
  "claude-code": "cccli",
  codex: "cdcli"
};

const CLI_TO_PROVIDER: Record<string, ProviderType> = {
  ctcli: "copilot",
  copilot: "copilot",
  copilotcli: "copilot",
  gmcli: "gemini",
  gemini: "gemini",
  geminicli: "gemini",
  cccli: "claude-code",
  claudecode: "claude-code",
  "claude-code": "claude-code",
  cdcli: "codex",
  codex: "codex",
  codexcli: "codex"
};

const REGISTERED_MODELS: SupportedModel[] = [
  { provider: "copilot", cli: "ctcli", model: "gpt-5.4", entry: "ctcli:gpt-5.4" },
  { provider: "copilot", cli: "ctcli", model: "gpt-5-mini", entry: "ctcli:gpt-5-mini" },
  { provider: "copilot", cli: "ctcli", model: "claude-opus-4.6", entry: "ctcli:claude-opus-4.6" },
  { provider: "copilot", cli: "ctcli", model: "claude-sonnet-4.6", entry: "ctcli:claude-sonnet-4.6" },
  { provider: "gemini", cli: "gmcli", model: "gemini-3.1-pro-preview", entry: "gmcli:gemini-3.1-pro-preview" },
  { provider: "claude-code", cli: "cccli", model: "claude-opus-4.7", entry: "cccli:claude-opus-4.7" },
  { provider: "claude-code", cli: "cccli", model: "claude-sonnet-4.6", entry: "cccli:claude-sonnet-4.6" },
  { provider: "claude-code", cli: "cccli", model: "claude-haiku-4.5", entry: "cccli:claude-haiku-4.5" },
  { provider: "codex", cli: "cdcli", model: "gpt-5.4", entry: "cdcli:gpt-5.4" },
  { provider: "codex", cli: "cdcli", model: "gpt-5.4-mini", entry: "cdcli:gpt-5.4-mini" }
];

const REGISTERED_MODEL_ENTRIES = new Set(REGISTERED_MODELS.map((item) => item.entry));

export function findProvidersForModel(model: string): ProviderType[] {
  const matches = new Set<ProviderType>();
  for (const item of REGISTERED_MODELS) {
    if (item.model === model) {
      matches.add(item.provider);
    }
  }
  return Array.from(matches);
}

export function cliLabelForProvider(provider: ProviderType): CliProviderLabel {
  return PROVIDER_TO_CLI[provider];
}

export function inferProviderFromModel(model: string, preferredProvider?: ProviderType): ProviderType {
  const matches = findProvidersForModel(model);
  if (preferredProvider && matches.includes(preferredProvider)) return preferredProvider;
  if (matches.length === 1) return matches[0]!;

  const lower = model.toLowerCase();
  if (lower.includes("gemini")) return "gemini";
  const ccModel = REGISTERED_MODELS.find((m) => m.provider === "claude-code" && m.model === model);
  if (ccModel) return "claude-code";
  if (preferredProvider) return preferredProvider;
  return "copilot";
}

export function formatModelEntry(provider: ProviderType, model: string): `${CliProviderLabel}:${string}` {
  return `${cliLabelForProvider(provider)}:${model}`;
}

export function parseModelEntry(entry: string, preferredProvider?: ProviderType): {
  provider: ProviderType;
  cli: CliProviderLabel;
  model: string;
} {
  const trimmed = entry.trim();
  const separatorIndex = trimmed.indexOf(":");
  if (separatorIndex === -1) {
    const provider = inferProviderFromModel(trimmed, preferredProvider);
    return { provider, cli: cliLabelForProvider(provider), model: trimmed };
  }

  const prefix = trimmed.slice(0, separatorIndex).trim().toLowerCase();
  const model = trimmed.slice(separatorIndex + 1).trim();
  const provider = CLI_TO_PROVIDER[prefix] ?? inferProviderFromModel(model, preferredProvider);
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
  return REGISTERED_MODEL_ENTRIES.has(normalized) ? normalized : fallback;
}

export async function loadSupportedModels(provider: ProviderType = "copilot"): Promise<string[]> {
  return REGISTERED_MODELS.filter((item) => item.provider === provider).map((item) => item.model);
}

export function getAllModels(): SupportedModel[] {
  return [...REGISTERED_MODELS];
}

export function getDefaultModel(models: string[]): string | undefined {
  const override = process.env[DEFAULT_MODEL_ENV];
  if (override) {
    const parsed = parseModelEntry(override);
    if (models.includes(parsed.model)) return parsed.model;
  }

  if (models.includes(DEFAULT_CORE_MODEL_NAME)) return DEFAULT_CORE_MODEL_NAME;

  return models[0];
}

export function getDefaultModelEnvName(): string {
  return DEFAULT_MODEL_ENV;
}
