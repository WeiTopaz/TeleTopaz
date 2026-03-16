/**
 * 模擬真實使用者的操作節奏
 * 避免 24/7 不間斷的機器式調用
 */
export class SessionPacer {
  private lastRequestTime = 0;
  private requestCount = 0;

  /** 在發送指令前調用，返回應等待的毫秒數 */
  getDelay(): number {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    this.requestCount++;

    // 首次請求無延遲
    if (this.lastRequestTime === 0) {
      this.lastRequestTime = now;
      return 0;
    }

    // 快速連續請求（<2秒）：加入 1-3 秒延遲
    if (elapsed < 2000) {
      return 1000 + Math.random() * 2000;
    }

    // 正常間隔：加入 0.5-1.5 秒的「打開終端」延遲
    this.lastRequestTime = now;
    return 500 + Math.random() * 1000;
  }
}
