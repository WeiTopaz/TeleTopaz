import { afterEach, describe, expect, it } from "vitest";
import * as modelConfig from "../src/config/models.js";

describe("model config", () => {
  const originalDefaultModel = process.env.TELETOPAZ_DEFAULT_MODEL;

  afterEach(() => {
    if (originalDefaultModel === undefined) {
      delete process.env.TELETOPAZ_DEFAULT_MODEL;
      return;
    }
    process.env.TELETOPAZ_DEFAULT_MODEL = originalDefaultModel;
  });

  it("matches REF model inventory with ctcli and gmcli aliases", () => {
    const entries = modelConfig.getAllModels().map((item) => item.entry ?? `${item.provider}:${item.model}`);

    expect(entries).toEqual([
      "ctcli:gpt-5.4",
      "ctcli:gpt-5-mini",
      "ctcli:claude-opus-4.6",
      "ctcli:claude-sonnet-4.6",
      "gmcli:gemini-3.1-pro-preview"
    ]);
  });

  it("loads the REF provider-specific model lists", async () => {
    await expect(modelConfig.loadSupportedModels("copilot")).resolves.toEqual([
      "gpt-5.4",
      "gpt-5-mini",
      "claude-opus-4.6",
      "claude-sonnet-4.6"
    ]);
    await expect(modelConfig.loadSupportedModels("gemini")).resolves.toEqual([
      "gemini-3.1-pro-preview"
    ]);
  });

  it("formats display entries with CLI aliases", () => {
    const formatModelEntry = (modelConfig as Record<string, unknown>).formatModelEntry;

    expect(formatModelEntry).toBeTypeOf("function");
    expect((formatModelEntry as (provider: string, model: string) => string)("copilot", "claude-sonnet-4.6")).toBe(
      "ctcli:claude-sonnet-4.6"
    );
    expect((formatModelEntry as (provider: string, model: string) => string)("gemini", "gemini-3.1-pro-preview")).toBe(
      "gmcli:gemini-3.1-pro-preview"
    );
  });

  it("accepts provider:model overrides when choosing the default model", () => {
    process.env.TELETOPAZ_DEFAULT_MODEL = "ctcli:claude-opus-4.6";

    expect(modelConfig.getDefaultModel(["gpt-5.4", "claude-opus-4.6"])).toBe("claude-opus-4.6");
  });
});
