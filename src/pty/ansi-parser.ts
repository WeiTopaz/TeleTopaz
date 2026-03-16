/**
 * ANSI escape code 剝離與輸出解析
 * 用於從 PTY 原始輸出中提取有意義的文字內容
 */

// 涵蓋 SGR (色彩)、CSI (游標)、OSC (標題) 等所有常見 escape sequence
const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\].*?(?:\x07|\x1B\\))/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

/**
 * 從 PTY 輸出流中提取有意義的回應內容
 * 過濾掉：進度條、spinner、游標移動、空行
 */
export function extractResponse(rawOutput: string): string {
  const clean = stripAnsi(rawOutput);

  return clean
    .split("\n")
    .filter(line => {
      const trimmed = line.trim();
      // 過濾 spinner 字元
      if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]/.test(trimmed)) return false;
      // 過濾進度條
      if (/^[\[█▓▒░\]]{3,}/.test(trimmed)) return false;
      // 過濾空行
      if (!trimmed) return false;
      return true;
    })
    .join("\n")
    .trim();
}
