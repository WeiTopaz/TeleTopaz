import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getRuntimeConfigPath, loadRuntimeConfig, saveRuntimeConfig } from "../src/config/runtime-config.js";

describe("runtime config", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (!tempDir) return;
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("persists non-secret startup settings in app data", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "teletopaz-runtime-config-"));

    await saveRuntimeConfig(
      {
        directoryPatterns: "/Users/test/Project/*"
      },
      { baseDir: tempDir }
    );

    const loaded = await loadRuntimeConfig({ env: {}, baseDir: tempDir });
    expect(loaded).toEqual({
      directoryPatterns: "/Users/test/Project/*"
    });

    const configPath = getRuntimeConfigPath({ baseDir: tempDir });
    const raw = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, string>;
    expect(raw).toEqual({
      directoryPatterns: "/Users/test/Project/*"
    });
  });

  it("prefers environment variables over stored runtime settings", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "teletopaz-runtime-config-"));

    await saveRuntimeConfig(
      {
        directoryPatterns: "/Users/test/Stored/*"
      },
      { baseDir: tempDir }
    );

    const loaded = await loadRuntimeConfig({
      env: {
        TELETOPAZ_DIRECTORY_PATTERNS: "/Users/test/Env/*"
      } as NodeJS.ProcessEnv,
      baseDir: tempDir
    });

    expect(loaded).toEqual({
      directoryPatterns: "/Users/test/Env/*"
    });
  });

  it("hydrates missing runtime settings from a legacy loader and persists the migrated values", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "teletopaz-runtime-config-"));

    const loaded = await loadRuntimeConfig({
      env: {},
      baseDir: tempDir,
      legacyConfigLoader: async () => ({
        directoryPatterns: "/Users/test/Legacy/*"
      })
    });

    expect(loaded).toEqual({
      directoryPatterns: "/Users/test/Legacy/*"
    });
    expect(await loadRuntimeConfig({ env: {}, baseDir: tempDir })).toEqual(loaded);
  });

  it("ignores legacy certificate fingerprint fields in stored config files", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "teletopaz-runtime-config-"));
    const configPath = getRuntimeConfigPath({ baseDir: tempDir });
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify({
        directoryPatterns: "/Users/test/Project/*",
        certificateFingerprints: "sha256/old"
      })}\n`,
      "utf8"
    );

    const loaded = await loadRuntimeConfig({ env: {}, baseDir: tempDir });

    expect(loaded).toEqual({
      directoryPatterns: "/Users/test/Project/*"
    });
  });
});
