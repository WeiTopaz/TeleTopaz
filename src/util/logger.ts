import { promises as fs } from "node:fs";
import path from "node:path";
import { redactUnknown } from "./redaction.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

function parseLogLevel(env?: string): LogLevel {
  const raw = (env ?? "").toLowerCase().trim();
  if (raw in LOG_LEVEL_ORDER) return raw as LogLevel;
  return "info";
}

function toLocalISOString(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const absOffset = Math.abs(offset);
  const sign = offset >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.floor(n)).padStart(2, "0");
  const pad3 = (n: number) => String(Math.floor(n)).padStart(3, "0");

  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const h = pad(date.getHours());
  const m = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  const ms = pad3(date.getMilliseconds());
  const offH = pad(absOffset / 60);
  const offM = pad(absOffset % 60);

  return `${year}-${month}-${day}T${h}:${m}:${s}.${ms}${sign}${offH}:${offM}`;
}

function formatArgs(args: unknown[]): string {
  return args.map((a) => {
    const redacted = redactUnknown(a);
    if (redacted instanceof Error) return `${redacted.message}\n${redacted.stack ?? ""}`;
    if (typeof redacted === "object" && redacted !== null) {
      try { return JSON.stringify(redacted); } catch { return String(redacted); }
    }
    return String(redacted);
  }).join(" ");
}

export class Logger {
  private level: LogLevel;
  private writeQueue: Promise<void> = Promise.resolve();
  private logDir: string;

  constructor(level?: LogLevel) {
    this.level = level ?? parseLogLevel(process.env.TELETOPAZ_LOG_LEVEL);
    this.logDir = process.env.TELETOPAZ_LOG_DIR?.trim() || "logs";
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  setLogDir(logDir: string): void {
    const normalized = logDir.trim();
    if (!normalized) return;
    this.logDir = normalized;
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[this.level];
  }

  private writeToFile(level: LogLevel, args: unknown[]): void {
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-CA"); // YYYY-MM-DD
    const ts = toLocalISOString(now);
    const line = `[${ts}] [${level.toUpperCase()}] ${formatArgs(args)}\n`;
    const filePath = path.join(this.logDir, `${dateStr}.log`);

    this.writeQueue = this.writeQueue
      .then(() => fs.mkdir(this.logDir, { recursive: true }))
      .then(() => fs.appendFile(filePath, line, "utf8"))
      .catch((err) => {
        console.error("Failed to write to log file:", err);
      });
  }

  debug(...args: unknown[]): void {
    if (!this.shouldLog("debug")) return;
    this.writeToFile("debug", args);
    console.debug(`[${toLocalISOString(new Date())}] [DEBUG]`, ...args.map(redactUnknown));
  }

  info(...args: unknown[]): void {
    if (!this.shouldLog("info")) return;
    this.writeToFile("info", args);
    console.log(`[${toLocalISOString(new Date())}] [INFO]`, ...args.map(redactUnknown));
  }

  warn(...args: unknown[]): void {
    if (!this.shouldLog("warn")) return;
    this.writeToFile("warn", args);
    console.warn(`[${toLocalISOString(new Date())}] [WARN]`, ...args.map(redactUnknown));
  }

  error(...args: unknown[]): void {
    if (!this.shouldLog("error")) return;
    this.writeToFile("error", args);
    console.error(`[${toLocalISOString(new Date())}] [ERROR]`, ...args.map(redactUnknown));
  }
}

export const logger = new Logger();
