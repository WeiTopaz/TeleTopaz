import fs from "node:fs/promises";
import path from "node:path";

/** Base directory for stats files, relative to project root (cwd). */
const STATS_DIR = path.resolve("logs", "stats");

export type UsageStats = {
  daily: number;
  monthly: number;
  lastResetDate: string;   // YYYY-MM-DD
  lastResetMonth: string;  // YYYY-MM
  byModel: Record<string, number>; // Monthly breakdown
};

type UsageDetail = {
  count: number;
  byProvider: Record<string, number>;
  byModel: Record<string, number>;
};

type DailyRecord = Record<string, UsageDetail>;

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
  private async monthlyStats(chatId: string, month: string): Promise<{ total: number; byModel: Record<string, number> }> {
    let total = 0;
    const byModel: Record<string, number> = {};
    
    try {
      const files = await fs.readdir(STATS_DIR);
      for (const file of files) {
        if (!file.endsWith(".json") || !file.startsWith(month)) continue;
        const record = await this.readDaily(file.replace(".json", ""));
        const userStats = record[chatId];
        if (userStats) {
          total += userStats.count ?? 0;
          if (userStats.byModel) {
            for (const [model, count] of Object.entries(userStats.byModel)) {
              byModel[model] = (byModel[model] ?? 0) + count;
            }
          }
        }
      }
    } catch {
      // directory may not exist yet
    }
    return { total, byModel };
  }

  async checkQuota(chatId: string): Promise<{ allowed: boolean; remaining: number; stats: UsageStats }> {
    const today = this.getToday();
    const month = this.getMonth();
    const dailyRecord = await this.readDaily(today);
    
    // Handle migration/compatibility if previous format was just { count: number }
    const userDaily = dailyRecord[chatId];
    const daily = userDaily?.count ?? 0;
    
    const { total: monthly, byModel } = await this.monthlyStats(chatId, month);

    return {
      allowed: true,
      remaining: 9999,
      stats: { daily, monthly, lastResetDate: today, lastResetMonth: month, byModel }
    };
  }

  async increment(chatId: string, provider: string, model: string): Promise<UsageStats> {
    const today = this.getToday();
    const month = this.getMonth();
    const dailyRecord = await this.readDaily(today);
    
    if (!dailyRecord[chatId]) {
      dailyRecord[chatId] = { count: 0, byProvider: {}, byModel: {} };
    }
    // Migration check
    if (typeof dailyRecord[chatId].byProvider === 'undefined') dailyRecord[chatId].byProvider = {};
    if (typeof dailyRecord[chatId].byModel === 'undefined') dailyRecord[chatId].byModel = {};

    dailyRecord[chatId]!.count++;
    
    const pKey = provider || "unknown";
    const mKey = model || "unknown";
    
    dailyRecord[chatId]!.byProvider[pKey] = (dailyRecord[chatId]!.byProvider[pKey] ?? 0) + 1;
    dailyRecord[chatId]!.byModel[mKey] = (dailyRecord[chatId]!.byModel[mKey] ?? 0) + 1;

    await this.writeDaily(today, dailyRecord);

    const daily = dailyRecord[chatId]!.count;
    const { total: monthly, byModel } = await this.monthlyStats(chatId, month);
    return { daily, monthly, lastResetDate: today, lastResetMonth: month, byModel };
  }
}

export const quotaService = new QuotaService();