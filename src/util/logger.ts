import { redactUnknown } from "./redaction.js";

export type LogLevel = "info" | "warn" | "error" | "debug";

export class Logger {
  info(...args: unknown[]): void {
    console.log(...args.map(redactUnknown));
  }

  warn(...args: unknown[]): void {
    console.warn(...args.map(redactUnknown));
  }

  error(...args: unknown[]): void {
    console.error(...args.map(redactUnknown));
  }

  debug(...args: unknown[]): void {
    if (process.env.DEBUG) {
      console.debug(...args.map(redactUnknown));
    }
  }
}

export const logger = new Logger();
