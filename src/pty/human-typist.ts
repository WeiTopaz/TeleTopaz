import type { IPty } from "node-pty";

/** 模擬人類鍵盤打字節奏 */
export class HumanTypist {
  private baseDelayMs = 45;
  private varianceMs = 35;
  private burstProbability = 0.15;
  private pauseProbability = 0.05;
  private maxBurstLength = 5;

  async type(pty: IPty, text: string): Promise<void> {
    let i = 0;
    while (i < text.length) {
      // 快速連打模式（模擬熟悉的單字/常用指令）
      if (Math.random() < this.burstProbability) {
        const burstLen = Math.min(
          1 + Math.floor(Math.random() * this.maxBurstLength),
          text.length - i
        );
        const burst = text.slice(i, i + burstLen);
        pty.write(burst);
        i += burstLen;
        await this.sleep(this.baseDelayMs * 0.3);
        continue;
      }

      // 思考停頓（模擬閱讀/思考）
      if (Math.random() < this.pauseProbability && i > 0) {
        await this.sleep(300 + Math.random() * 700);
      }

      // 正常打字
      pty.write(text[i]!);
      i++;

      const delay = this.calculateDelay(text[i - 1]!, text[i]);
      await this.sleep(delay);
    }
  }

  private calculateDelay(current: string, next?: string): number {
    let delay = this.baseDelayMs + (Math.random() - 0.5) * 2 * this.varianceMs;

    // 空格後稍微快一點
    if (current === " ") delay *= 0.7;
    // 標點符號後慢一點
    if (/[.!?,;:]/.test(current)) delay *= 1.5;
    // Enter 前有較長停頓
    if (current === "\n") delay = 100 + Math.random() * 200;
    // 中文字元打字稍慢（模擬輸入法選字）
    if (/[\u4e00-\u9fff]/.test(current)) delay *= 1.3;

    return Math.max(15, delay);
  }

  private sleep(ms: number): Promise<void> {
    const jitter = (Math.random() - 0.5) * 4;
    return new Promise(resolve => setTimeout(resolve, Math.max(1, ms + jitter)));
  }
}

/**
 * 長文本輸入策略：
 * - 短文本 (< 200 字元)：逐字元擬人打字
 * - 中等文本 (200-2000 字元)：分段貼上，段間加停頓
 * - 長文本 (> 2000 字元)：使用剪貼簿模擬貼上
 */
export async function smartInput(pty: IPty, text: string, typist: HumanTypist): Promise<void> {
  if (text.length < 200) {
    await typist.type(pty, text);
    return;
  }

  if (text.length < 2000) {
    const chunks = splitIntoChunks(text, 80, 150);
    for (const chunk of chunks) {
      await sleep(50 + Math.random() * 100);
      pty.write(chunk);
      await sleep(100 + Math.random() * 200);
    }
    return;
  }

  // 長文本：模擬 Cmd+V 整段貼上
  await sleep(200 + Math.random() * 300);
  pty.write(text);
  await sleep(300 + Math.random() * 500);
}

function splitIntoChunks(text: string, minSize: number, maxSize: number): string[] {
  const chunks: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    const size = minSize + Math.floor(Math.random() * (maxSize - minSize));
    chunks.push(text.slice(pos, pos + size));
    pos += size;
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
