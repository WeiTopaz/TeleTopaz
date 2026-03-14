import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type RestartState,
  clearRestartState,
  loadRestartState,
  saveRestartState,
} from "../src/restart.js";

vi.mock("node:fs", async () => {
  const store = new Map<string, string>();
  return {
    existsSync: vi.fn((p: string) => store.has(p)),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn((p: string) => {
      const v = store.get(p);
      if (v === undefined) throw new Error("ENOENT");
      return v;
    }),
    writeFileSync: vi.fn((p: string, data: string) => {
      store.set(p, data);
    }),
    unlinkSync: vi.fn((p: string) => {
      store.delete(p);
    }),
    // Expose store for test manipulation
    __store: store,
  };
});

describe("restart state management", () => {
  let store: Map<string, string>;

  beforeEach(async () => {
    const fsMock = await import("node:fs");
    store = (fsMock as unknown as { __store: Map<string, string> }).__store;
    store.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loadRestartState returns null when no file exists", () => {
    expect(loadRestartState()).toBeNull();
  });

  it("saveRestartState and loadRestartState roundtrip", () => {
    const state: RestartState = {
      triggeredBy: "user",
      triggeredAt: 1710000000000,
      previousGitSha: "abc123",
      hadUncommittedChanges: true,
      rollbackCount: 0,
    };
    saveRestartState(state);
    const loaded = loadRestartState();
    expect(loaded).toEqual(state);
  });

  it("clearRestartState removes the state file", () => {
    const state: RestartState = {
      triggeredBy: "user",
      triggeredAt: 1710000000000,
      previousGitSha: "abc123",
      hadUncommittedChanges: false,
      rollbackCount: 0,
    };
    saveRestartState(state);
    expect(loadRestartState()).not.toBeNull();
    clearRestartState();
    expect(loadRestartState()).toBeNull();
  });

  it("saveRestartState overwrites existing state", () => {
    const state1: RestartState = {
      triggeredBy: "user",
      triggeredAt: 1710000000000,
      previousGitSha: "abc123",
      hadUncommittedChanges: false,
      rollbackCount: 0,
    };
    const state2: RestartState = {
      triggeredBy: "system",
      triggeredAt: 1710000001000,
      previousGitSha: "abc123",
      hadUncommittedChanges: false,
      rollbackCount: 1,
    };
    saveRestartState(state1);
    saveRestartState(state2);
    const loaded = loadRestartState();
    expect(loaded).toEqual(state2);
  });
});
