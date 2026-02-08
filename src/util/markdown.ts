const MARKDOWN_V2_SPECIAL = /[_*\[\]()~`>#+\-=|{}.!\\]/g;

function escapeMarkdownV2(text: string): string {
  return text.replace(MARKDOWN_V2_SPECIAL, "\\$&");
}

function convertHeaders(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const match = /^(#{1,6})\s+(.*)$/.exec(line);
      if (!match) return line;
      const content = match[2] ?? "";
      return `**${content}**`;
    })
    .join("\n");
}

function escapeCodeBlock(text: string): string {
  return text.replace(/[\\`]/g, "\\$&");
}

function processInlineCode(text: string): string {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("`", cursor);
    if (start === -1) {
      parts.push(processPlainText(text.slice(cursor)));
      break;
    }
    const end = text.indexOf("`", start + 1);
    if (end === -1) {
      parts.push(processPlainText(text.slice(cursor)));
      break;
    }
    parts.push(processPlainText(text.slice(cursor, start)));
    const code = text.slice(start + 1, end);
    parts.push("`" + escapeCodeBlock(code) + "`");
    cursor = end + 1;
  }
  return parts.join("");
}

function processPlainText(text: string): string {
  const withHeaders = convertHeaders(text);
  // Escape all MarkdownV2 special characters first
  let result = escapeMarkdownV2(withHeaders);
  // Selectively un-escape properly paired formatting markers
  // Multi-char markers first to avoid conflicts with single-char
  result = result.replace(/\\\*\\\*(.+?)\\\*\\\*/g, "*$1*");       // **bold** → *bold*
  result = result.replace(/\\_\\_(.+?)\\_\\_/g, "__$1__");          // __underline__
  result = result.replace(/\\~\\~(.+?)\\~\\~/g, "~$1~");           // ~~strike~~ → ~strike~
  // Single-char markers
  result = result.replace(/\\\*(.+?)\\\*/g, "*$1*");               // *bold*
  // _italic_ only at non-word boundaries to avoid matching snake_case identifiers
  result = result.replace(/(?<![a-zA-Z0-9])\\_([^\n]+?)\\_(?![a-zA-Z0-9])/g, "_$1_");
  return result;
}

export function markdownToTelegram(text: string): string {
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
    const content = text.slice(start + 3, end);
    parts.push("```" + escapeCodeBlock(content) + "```");
    cursor = end + 3;
  }
  return parts.join("");
}

export function splitLongMessage(text: string, limit = 4096): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const searchFrom = Math.floor(limit * 0.75);
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < searchFrom) {
      cut = limit;
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.length) chunks.push(remaining);
  return chunks;
}
