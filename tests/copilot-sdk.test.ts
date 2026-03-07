import { describe, expect, it, vi } from "vitest";
import { CopilotSdkClient } from "../src/copilot/sdk.js";

describe("CopilotSdkClient", () => {
  it("passes approvalMode through to the underlying SDK session options", async () => {
    const createSession = vi.fn().mockResolvedValue({
      on: vi.fn(),
      send: vi.fn(),
      sendAndWait: vi.fn(),
      destroy: vi.fn(),
      abort: vi.fn()
    });
    const client = new CopilotSdkClient();

    (client as unknown as {
      client: { createSession: (...args: unknown[]) => Promise<unknown> };
    }).client = {
      createSession
    };

    await client.createSession({
      model: "gpt-5-mini",
      approvalMode: "plan"
    });

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalMode: "plan"
      })
    );
  });

  it("passes onPermissionRequest through to the underlying SDK session options", async () => {
    const createSession = vi.fn().mockResolvedValue({
      on: vi.fn(),
      send: vi.fn(),
      sendAndWait: vi.fn(),
      destroy: vi.fn(),
      abort: vi.fn()
    });
    const onPermissionRequest = vi.fn().mockResolvedValue({ kind: "approved" });
    const client = new CopilotSdkClient();

    (client as unknown as {
      client: { createSession: (...args: unknown[]) => Promise<unknown> };
    }).client = {
      createSession
    };

    await client.createSession({
      model: "gpt-5-mini",
      onPermissionRequest
    });

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        onPermissionRequest
      })
    );
  });
});
