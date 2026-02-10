import fs from "node:fs/promises";
import path from "node:path";

/** Base directory for stats files, relative to project root (cwd). */
const STATS_DIR = path.resolve("logs", "stats");

export type UsageStats = {
  daily: number;
  monthly: number;
  lastResetDate: string;   // YYYY-MM-DD
  lastResetMonth: string;  // YYYY-MM
};

type DailyRecord = Record<string, { count: number }>;

export class QuotaService {
  private getToday(): string {
    return new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD
  }

  private getMonth(): string {
    return new Date().toLocaleDateString("en-CA").slice(0, 7); // YYYY-MM
  }

  private dailyFilePath(date: string): string {
    return path.join(STATS_DIR, `${date}.json`);
  }

  private async readDaily(date: string): Promise<DailyRecord> {
    try {
      const data = await fs.readFile(this.dailyFilePath(date), "utf-8");
      return JSON.parse(data) as DailyRecord;
    } catch {
      return {};
    }
  }

  private async writeDaily(date: string, record: DailyRecord): Promise<void> {
    try {
      await fs.mkdir(STATS_DIR, { recursive: true });
      await fs.writeFile(this.dailyFilePath(date), JSON.stringify(record, null, 2), "utf-8");
    } catch (err) {
      console.error("Failed to save stats", err);
    }
  }

  /** Sum counts for all days in the given month (YYYY-MM) for a chatId. */
  private async monthlyTotal(chatId: string, month: string): Promise<number> {
    let total = 0;
    try {
      const files = await fs.readdir(STATS_DIR);
      for (const file of files) {
        if (!file.endsWith(".json") || !file.startsWith(month)) continue;
        const record = await this.readDaily(file.replace(".json", ""));
        total += record[chatId]?.count ?? 0;
      }
    } catch {
      // directory may not exist yet
    }
    return total;
  }

  async checkQuota(chatId: string): Promise<{ allowed: boolean; remaining: number; stats: UsageStats }> {
    const today = this.getToday();
    const month = this.getMonth();
    const dailyRecord = await this.readDaily(today);
    const daily = dailyRecord[chatId]?.count ?? 0;
    const monthly = await this.monthlyTotal(chatId, month);

    return {
      allowed: true,
      remaining: 9999,
      stats: { daily, monthly, lastResetDate: today, lastResetMonth: month }
    };
  }

  async increment(chatId: string): Promise<UsageStats> {
    const today = this.getToday();
    const month = this.getMonth();
    const dailyRecord = await this.readDaily(today);
    if (!dailyRecord[chatId]) {
      dailyRecord[chatId] = { count: 0 };
    }
    dailyRecord[chatId]!.count++;
    await this.writeDaily(today, dailyRecord);

    const daily = dailyRecord[chatId]!.count;
    const monthly = await this.monthlyTotal(chatId, month);
    return { daily, monthly, lastResetDate: today, lastResetMonth: month };
  }
}

export const quotaService = new QuotaService();