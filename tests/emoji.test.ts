import { describe, it, expect } from "vitest";
import { pickIcon, getIconPool } from "../src/session/emoji.js";

describe("pickIcon", () => {
  it("picks an icon not in the used set", () => {
    const used = new Set<string>();
    const icon = pickIcon(used);
    expect(getIconPool()).toContain(icon);
    expect(used.size).toBe(0); // does not mutate the set
  });

  it("excludes already used icons", () => {
    const pool = getIconPool();
    // Use all icons except the last one
    const used = new Set(pool.slice(0, pool.length - 1));
    const icon = pickIcon(used);
    expect(icon).toBe(pool[pool.length - 1]);
  });

  it("returns an icon from the pool when all are used", () => {
    const pool = getIconPool();
    const used = new Set(pool);
    const icon = pickIcon(used);
    expect(pool).toContain(icon);
  });

  it("picks different icons for different used sets", () => {
    const pool = getIconPool();
    const icon1 = pickIcon(new Set());
    const icon2 = pickIcon(new Set([icon1]));
    expect(icon2).toBe(pool[1]); // second icon since first is used
  });
});

describe("getIconPool", () => {
  it("returns a non-empty array of emoji", () => {
    const pool = getIconPool();
    expect(pool.length).toBeGreaterThan(0);
  });

  it("returns a new array each time (does not share reference)", () => {
    const pool1 = getIconPool();
    const pool2 = getIconPool();
    pool1.push("extra");
    expect(pool2).not.toContain("extra");
  });
});
