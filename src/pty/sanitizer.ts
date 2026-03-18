/**
 * PTY 輸入消毒器
 *
 * 核心原則：寫入 PTY 的所有內容都是「給 CLI 的 prompt」，
 * 而非 shell 指令。但由於 PTY 可能連接到 shell，必須防範逃逸。
 */

// 危險的控制字元（可能觸發 shell 特殊行為）
const DANGEROUS_CHARS = [
  "\x03",  // Ctrl+C (SIGINT)
  "\x04",  // Ctrl+D (EOF)
  "\x1A",  // Ctrl+Z (SIGTSTP)
  "\x1C",  // Ctrl+\\ (SIGQUIT)
  "\x1B",  // ESC (escape sequences)
];

// Shell 注入模式
const SHELL_INJECTION_PATTERNS = [
  /`[^`]+`/,           // 反引號命令替換
  /\$\([^)]+\)/,       // $() 命令替換
  /\$\{[^}]+\}/,       // ${} 變數展開
  /;\s*\w/,            // 分號後接指令
  /\|\s*\w/,           // 管道
  /&&\s*\w/,           // AND 鏈
  /\|\|\s*\w/,         // OR 鏈
  />\s*\//,            // 重定向到絕對路徑
  /2>&1/,              // stderr 重定向
];

export function sanitizePtyInput(input: string): string {
  let sanitized = input;
  for (const char of DANGEROUS_CHARS) {
    sanitized = sanitized.replaceAll(char, "");
  }
  return sanitized;
}

/**
 * 檢查輸入是否包含潛在的 shell 注入
 * 回傳 true 表示安全，false 表示可疑
 */
export function isInputSafe(input: string): boolean {
  for (const pattern of SHELL_INJECTION_PATTERNS) {
    if (pattern.test(input)) {
      return false;
    }
  }
  return true;
}
