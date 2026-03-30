/**
 * WhatsApp 訊息格式化工具
 *
 * WhatsApp 支援的格式：
 *   *粗體*  _斜體_  ~刪除線~  ```程式碼區塊```  `行內程式碼`
 *
 * 此模組將通用 Markdown 轉換為 WhatsApp 格式，並提供智慧長訊息分割。
 */

/**
 * 將通用 Markdown 轉換為 WhatsApp 格式。
 * 先保護程式碼區塊與行內程式碼不被處理，再轉換其他格式標記。
 */
export function markdownToWhatsApp(text: string): string {
  const parts: string[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const start = text.indexOf("```", cursor);
    if (start === -1) {
      parts.push(processInlineCode(text.slice(cursor)));
      break;
    }
    const end = text.indexOf("```", start + 3);
    if (end === -1) {
      parts.push(processInlineCode(text.slice(cursor)));
      break;
    }
    parts.push(processInlineCode(text.slice(cursor, start)));
    // 保留程式碼區塊原文（WhatsApp 使用相同語法）
    parts.push("```" + text.slice(start + 3, end) + "```");
    cursor = end + 3;
  }

  return parts.join("");
}

function processInlineCode(text: string): string {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("`", cursor);
    if (start === -1) {
      parts.push(processText(text.slice(cursor)));
      break;
    }
    const end = text.indexOf("`", start + 1);
    if (end === -1) {
      parts.push(processText(text.slice(cursor)));
      break;
    }
    parts.push(processText(text.slice(cursor, start)));
    // 保留行內程式碼原文（WhatsApp 使用相同語法）
    parts.push("`" + text.slice(start + 1, end) + "`");
    cursor = end + 1;
  }
  return parts.join("");
}

function processText(text: string): string {
  let result = text;
  // 標題：# 標題 → *標題*（WhatsApp 以粗體呈現）
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
  // 粗體：**text** → *text*（WhatsApp 粗體語法）
  result = result.replace(/\*\*(.+?)\*\*/gs, "*$1*");
  // 底線粗體：__text__ → _text_（WhatsApp 斜體語法）
  result = result.replace(/__(.+?)__/gs, "_$1_");
  // 刪除線：~~text~~ → ~text~（WhatsApp 刪除線語法）
  result = result.replace(/~~(.+?)~~/gs, "~$1~");
  return result;
}

/**
 * 智慧分割長訊息，優先在換行處切割。
 * 預設上限 4000 字元（WhatsApp 訊息長度限制）。
 */
export function splitLongMessage(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const searchFrom = Math.floor(limit * 0.75);
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < searchFrom) cut = limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.length) chunks.push(remaining);
  return chunks;
}
