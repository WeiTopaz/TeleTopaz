import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const QUOTA_FILE = path.join(os.homedir(), ".gemini", "quota.json");

export type UsageStats = {
  daily: number;
  monthly: number;
  lastResetDate: string;   // YYYY-MM-DD
  lastResetMonth: string;  // YYYY-MM
};

export class QuotaService {
  private stats: Record<string, UsageStats> = {};
  private loaded = false;

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const data = await fs.readFile(QUOTA_FILE, "utf-8");
      this.stats = JSON.parse(data);
    } catch {
      this.stats = {};
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(QUOTA_FILE), { recursive: true });
      await fs.writeFile(QUOTA_FILE, JSON.stringify(this.stats, null, 2));
    } catch (err) {
      console.error("Failed to save quota stats", err);
    }
  }

  private getToday(): string {
    return new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD
  }

  private getMonth(): string {
    return new Date().toLocaleDateString("en-CA").slice(0, 7); // YYYY-MM
  }

  // Modified to always return allowed: true, just for stats tracking
  async checkQuota(chatId: string): Promise<{ allowed: boolean; remaining: number; stats: UsageStats }> {
    await this.load();
    const today = this.getToday();
    const month = this.getMonth();
    
    let record = this.stats[chatId];
    if (!record) {
      record = { daily: 0, monthly: 0, lastResetDate: today, lastResetMonth: month };
      this.stats[chatId] = record;
    }

    if (record.lastResetDate !== today) {
      record.daily = 0;
      record.lastResetDate = today;
    }
    
    if (record.lastResetMonth !== month) {
      record.monthly = 0;
      record.lastResetMonth = month;
    }

    await this.save();

    return {
      allowed: true, // Always allowed as per requirement
      remaining: 9999,
      stats: { ...record }
    };
  }

  async increment(chatId: string): Promise<UsageStats> {
    await this.load();
    const today = this.getToday();
    const month = this.getMonth();
    
    let record = this.stats[chatId];
    if (!record) {
      record = { daily: 0, monthly: 0, lastResetDate: today, lastResetMonth: month };
      this.stats[chatId] = record;
    }

    if (record.lastResetDate !== today) {
      record.daily = 0;
      record.lastResetDate = today;
    }
    if (record.lastResetMonth !== month) {
      record.monthly = 0;
      record.lastResetMonth = month;
    }

    record.daily++;
    record.monthly++;
    await this.save();
    return { ...record };
  }
}

export const quotaService = new QuotaService();