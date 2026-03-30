import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockToBuffer, mockJpeg, mockRotate, mockSharp } = vi.hoisted(() => {
  const mockToBuffer = vi.fn();
  const mockJpeg = vi.fn().mockReturnValue({ toBuffer: mockToBuffer });
  const mockRotate = vi.fn().mockReturnValue({ jpeg: mockJpeg });
  const mockSharp = vi.fn().mockReturnValue({ rotate: mockRotate });
  return { mockToBuffer, mockJpeg, mockRotate, mockSharp };
});

vi.mock("sharp", () => ({ default: mockSharp }));

import { reencodePhoto } from "../src/util/images.js";

describe("reencodePhoto", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockToBuffer.mockResolvedValue(Buffer.from("encoded-image-data"));
    mockJpeg.mockReturnValue({ toBuffer: mockToBuffer });
    mockRotate.mockReturnValue({ jpeg: mockJpeg });
    mockSharp.mockReturnValue({ rotate: mockRotate });
  });

  it("calls sharp with the input buffer", async () => {
    const input = Buffer.from("fake-image-data");
    await reencodePhoto(input);
    expect(mockSharp).toHaveBeenCalledWith(input);
  });

  it("applies auto-rotation", async () => {
    const input = Buffer.from("fake-image");
    await reencodePhoto(input);
    expect(mockRotate).toHaveBeenCalledWith();
  });

  it("encodes to JPEG with quality 80 and mozjpeg", async () => {
    const input = Buffer.from("fake-image");
    await reencodePhoto(input);
    expect(mockJpeg).toHaveBeenCalledWith({ quality: 80, mozjpeg: true });
  });

  it("returns the encoded buffer", async () => {
    const expected = Buffer.from("re-encoded-output");
    mockToBuffer.mockResolvedValue(expected);
    const result = await reencodePhoto(Buffer.from("input"));
    expect(result).toBe(expected);
  });

  it("propagates sharp errors", async () => {
    mockToBuffer.mockRejectedValue(new Error("sharp processing failed"));
    await expect(reencodePhoto(Buffer.from("bad-image"))).rejects.toThrow("sharp processing failed");
  });
});
