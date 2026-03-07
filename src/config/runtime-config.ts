import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveAppDataDir } from "../util/app-data.js";

const RUNTIME_CONFIG_FILE = "runtime-config.json";

export type RuntimeConfig = {
  directoryPatterns: string | undefined;
  certificateFingerprints: string | undefined;
};

type RuntimeConfigOptions = {
  env?: NodeJS.ProcessEnv;
  baseDir?: string | undefined;
  legacyConfigLoader?: (() => Promise<RuntimeConfig>) | undefined;
};

type RuntimeConfigFile = {
  directoryPatterns?: unknown;
  certificateFingerprints?: unknown;
};

function coerceOptionalString(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
  return {
    directoryPatterns: coerceOptionalString(config.directoryPatterns),
    certificateFingerprints: coerceOptionalString(config.certificateFingerprints)
  };
}

function mergeRuntimeConfig(primary: RuntimeConfig, fallback: RuntimeConfig): RuntimeConfig {
  return normalizeRuntimeConfig({
    directoryPatterns: primary.directoryPatterns ?? fallback.directoryPatterns,
    certificateFingerprints: primary.certificateFingerprints ?? fallback.certificateFingerprints
  });
}

function parseRuntimeConfigFile(raw: string): RuntimeConfig {
  const parsed = JSON.parse(raw) as RuntimeConfigFile;
  return {
    directoryPatterns:
      typeof parsed.directoryPatterns === "string" ? coerceOptionalString(parsed.directoryPatterns) : undefined,
    certificateFingerprints:
      typeof parsed.certificateFingerprints === "string"
        ? coerceOptionalString(parsed.certificateFingerprints)
        : undefined
  };
}

export function getRuntimeConfigPath(options: RuntimeConfigOptions = {}): string {
  const env = options.env ?? process.env;
  const baseDir = options.baseDir ? path.resolve(options.baseDir) : resolveAppDataDir(env);
  return path.join(baseDir, RUNTIME_CONFIG_FILE);
}

export async function loadRuntimeConfig(options: RuntimeConfigOptions = {}): Promise<RuntimeConfig> {
  const env = options.env ?? process.env;
  const { legacyConfigLoader } = options;
  const configPath = getRuntimeConfigPath(options);

  let storedConfig: RuntimeConfig = {
    directoryPatterns: undefined,
    certificateFingerprints: undefined
  };
  try {
    const raw = await fs.readFile(configPath, "utf8");
    storedConfig = parseRuntimeConfigFile(raw);
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== "ENOENT") {
      throw err;
    }
  }

  let effectiveStoredConfig = storedConfig;
  if (
    legacyConfigLoader &&
    (!storedConfig.directoryPatterns || !storedConfig.certificateFingerprints)
  ) {
    const legacyConfig = normalizeRuntimeConfig(await legacyConfigLoader());
    const migratedStoredConfig = mergeRuntimeConfig(storedConfig, legacyConfig);

    if (
      migratedStoredConfig.directoryPatterns !== storedConfig.directoryPatterns ||
      migratedStoredConfig.certificateFingerprints !== storedConfig.certificateFingerprints
    ) {
      await saveRuntimeConfig(migratedStoredConfig, { env, baseDir: options.baseDir });
    }

    effectiveStoredConfig = migratedStoredConfig;
  }

  return normalizeRuntimeConfig({
    directoryPatterns: coerceOptionalString(env.TELETOPAZ_DIRECTORY_PATTERNS) ?? effectiveStoredConfig.directoryPatterns,
    certificateFingerprints:
      coerceOptionalString(env.TELETOPAZ_CERT_FINGERPRINTS) ?? effectiveStoredConfig.certificateFingerprints
  });
}

export async function saveRuntimeConfig(config: RuntimeConfig, options: RuntimeConfigOptions = {}): Promise<void> {
  const configPath = getRuntimeConfigPath(options);
  const normalized = normalizeRuntimeConfig(config);

  if (!normalized.directoryPatterns && !normalized.certificateFingerprints) {
    await fs.rm(configPath, { force: true });
    return;
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(configPath, 0o600);
}
