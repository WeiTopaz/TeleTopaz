import sharp from "sharp";

export async function reencodePhoto(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer).rotate().jpeg({ quality: 80, mozjpeg: true }).toBuffer();
}
