import * as pty from "node-pty";
import { stripAnsi, extractResponse } from "./ansi-parser.js";
import { CompletionDetector } from "./completion-detector.js";
import { HumanTypist, smartInput } from "./human-typist.js";
import { sanitizePtyInput, isInputSafe } from "./sanitizer.js";
import { logger } from "../util/logger.js";

export type PtyRunnerOptions = {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  onOutput?: (data: string) => void;
  onCleanOutput?: (text: string) => void;
  onPromptDetected?: (prompt: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  silentThresholdMs?: number;
};

export type PtyRunnerResult = {
  output: string;
  cleanOutput: string;
  exitCode: number;
};

export class PtyRunner {
  private ptyProcess: pty.IPty | null = null;
  private typist: HumanTypist;

  constructor() {
    this.typist = new HumanTypist();
  }

  async execute(options: PtyRunnerOptions): Promise<PtyRunnerResult> {
    const {
      command, args, cwd,
      cols = 120, rows = 40,
      signal, timeoutMs = 120_000,
      silentThresholdMs = 3000,
    } = options;

    const env = {
      ...buildTerminalEnv(),
      ...options.env,
    };

    return new Promise<PtyRunnerResult>((resolve, reject) => {
      let rawOutput = "";
      let resolved = false;
      let timeoutTimer: NodeJS.Timeout | null = null;

      const finish = (err: Error | null, result?: PtyRunnerResult) => {
        if (resolved) return;
        resolved = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        detector.dispose();
        signal?.removeEventListener("abort", abortHandler);
        if (err) reject(err);
        else resolve(result!);
      };

      const abortHandler = () => {
        this.ptyProcess?.kill();
        finish(new Error("aborted"));
      };

      // 啟動 PTY 進程
      this.ptyProcess = pty.spawn(command, args, {
        name: "xterm-ghostty",
        cols,
        rows,
        cwd,
        env,
      });

      // 完成偵測器
      const detector = new CompletionDetector(() => {
        const clean = extractResponse(rawOutput);
        finish(null, {
          output: rawOutput,
          cleanOutput: clean,
          exitCode: 0,
        });
      }, silentThresholdMs);

      // 輸出處理
      this.ptyProcess.onData((data: string) => {
        rawOutput += data;
        options.onOutput?.(data);

        const cleanChunk = stripAnsi(data);
        if (cleanChunk.trim()) {
          options.onCleanOutput?.(cleanChunk);
        }

        // 偵測互動提示
        if (this.detectInteractivePrompt(cleanChunk)) {
          options.onPromptDetected?.(cleanChunk);
        }

        detector.feed(cleanChunk);
      });

      // 進程退出
      this.ptyProcess.onExit(({ exitCode, signal: sig }) => {
        const clean = extractResponse(rawOutput);
        finish(null, {
          output: rawOutput,
          cleanOutput: clean,
          exitCode: exitCode ?? (sig ? 128 + sig : 1),
        });
      });

      // 超時保護
      timeoutTimer = setTimeout(() => {
        this.ptyProcess?.kill();
        finish(new Error(`timeout: PTY process exceeded ${timeoutMs}ms`));
      }, timeoutMs);

      // 中斷信號
      signal?.addEventListener("abort", abortHandler);
    });
  }

  /** 以擬人化方式輸入文字（自動選擇策略） */
  async typeInput(text: string): Promise<void> {
    if (!this.ptyProcess) throw new Error("PTY not running");
    const sanitized = sanitizePtyInput(text);
    if (!isInputSafe(sanitized)) {
      logger.warn("PTY input contains suspicious shell patterns", { length: sanitized.length });
    }
    await smartInput(this.ptyProcess, sanitized, this.typist);
  }

  /** 直接寫入（用於自動回應 y/n，不需延遲） */
  writeImmediate(text: string): void {
    this.ptyProcess?.write(text);
  }

  /** 調整終端大小 */
  resize(cols: number, rows: number): void {
    this.ptyProcess?.resize(cols, rows);
  }

  kill(): void {
    this.ptyProcess?.kill();
  }

  get pid(): number | undefined {
    return this.ptyProcess?.pid;
  }

  private detectInteractivePrompt(text: string): boolean {
    const patterns = [
      /\(y\/n\)/i,
      /\[Y\/n\]/i,
      /\[yes\/no\]/i,
      /Press Enter/i,
      /continue\?/i,
      /confirm/i,
      /Do you want to/i,
      /Are you sure/i,
    ];
    return patterns.some(p => p.test(text));
  }
}

/**
 * 構建偽裝終端環境變數
 * 模擬 Ghostty 終端的完整指紋
 */
function buildTerminalEnv(): Record<string, string> {
  const home = process.env.HOME || "/Users/default";

  // 安全限制：只繼承已知安全的環境變數
  const safeInheritKeys = [
    "TMPDIR",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "CLOUDSDK_CONFIG",
  ];

  const env: Record<string, string> = {
    // 終端類型 — Ghostty 使用 xterm-ghostty
    TERM: "xterm-ghostty",
    TERM_PROGRAM: "ghostty",
    TERM_PROGRAM_VERSION: "1.1.3",
    COLORTERM: "truecolor",

    // Shell 環境
    SHELL: process.env.SHELL || "/bin/zsh",
    LANG: process.env.LANG || "zh_TW.UTF-8",
    LC_ALL: process.env.LC_ALL || "zh_TW.UTF-8",

    // 終端尺寸
    COLUMNS: "120",
    LINES: "40",

    // 使用者環境
    HOME: home,
    USER: process.env.USER || "user",
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    LOGNAME: process.env.LOGNAME || process.env.USER || "user",

    // Ghostty 特有
    GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app/Contents/Resources/ghostty",

    // 強制色彩
    FORCE_COLOR: "3",

    // XDG 標準路徑
    XDG_DATA_HOME: `${home}/.local/share`,
    XDG_CONFIG_HOME: `${home}/.config`,
    XDG_CACHE_HOME: `${home}/.cache`,
  };

  for (const key of safeInheritKeys) {
    if (process.env[key]) {
      env[key] = process.env[key]!;
    }
  }

  return env;
}
