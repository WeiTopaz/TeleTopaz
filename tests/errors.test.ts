import { describe, it, expect } from "vitest";
import { isConnectionDisposedError } from "../src/util/errors.js";

describe("errors", () => {
  it("detects connection disposed", () => {
    expect(isConnectionDisposedError({ code: -32097 })).toBe(true);
    expect(isConnectionDisposedError({ message: "connection got disposed" })).toBe(true);
  });
});
