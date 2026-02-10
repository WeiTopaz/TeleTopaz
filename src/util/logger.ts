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
  private filePath: string | undefined;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(level?: LogLevel, filePath?: string) {
    this.level = level ?? parseLogLevel(process.env.TELETOPAZ_LOG_LEVEL);
    this.filePath = filePath ?? process.env.TELETOPAZ_LOG_FILE;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  setFilePath(filePath: string): void {
    this.filePath = filePath;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[this.level];
  }

  private writeToFile(level: LogLevel, args: unknown[]): void {
    if (!this.filePath) return;
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level.toUpperCase()}] ${formatArgs(args)}\n`;
    const fp = this.filePath;
    this.writeQueue = this.writeQueue
      .then(() => fs.mkdir(path.dirname(fp), { recursive: true }))
      .then(() => fs.appendFile(fp, line, "utf8"))
      .catch(() => { /* ignore file write errors */ });
  }

  debug(...args: unknown[]): void {
    if (!this.shouldLog("debug")) return;
    this.writeToFile("debug", args);
    console.debug(...args.map(redactUnknown));
  }

  info(...args: unknown[]): void {
    if (!this.shouldLog("info")) return;
    this.writeToFile("info", args);
    console.log(...args.map(redactUnknown));
  }

  warn(...args: unknown[]): void {
    if (!this.shouldLog("warn")) return;
    this.writeToFile("warn", args);
    console.warn(...args.map(redactUnknown));
  }

  error(...args: unknown[]): void {
    if (!this.shouldLog("error")) return;
    this.writeToFile("error", args);
    console.error(...args.map(redactUnknown));
  }
}

export const logger = new Logger();
