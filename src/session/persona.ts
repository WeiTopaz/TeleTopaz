import { promises as fs } from "node:fs";
import path from "node:path";

function todayStamp(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function resolveProviderName(provider?: string): string {
  switch (provider) {
    case "gemini":
      return "Google Gemini";
    case "claude-code":
      return "Claude Code";
    case "codex":
      return "OpenAI Codex";
    default:
      return "GitHub Copilot SDK";
  }
}

const NO_GUI_ENVIRONMENT_NOTICE =
  "環境限制：本代理在無 GUI 終端下執行（headless / sandbox）。禁止呼叫 open -a、osascript、AppleScript、Computer Use，或任何會啟動 macOS 桌面應用程式與外部 app/connector 的工具。檔案讀寫請直接使用內建的 shell / 編輯器工具，不要 fall back 到外部 GUI 編輯器或其他外部連接器。";

export async function buildPersonaPrompt(cwd: string, provider?: string, memoryContext?: string): Promise<string> {
  const sections: string[] = [];
  const providerName = resolveProviderName(provider);
  sections.push(`你是 ${providerName} 的代理。工作目錄：${cwd}`);

  const files: { title: string; path: string }[] = [
    { title: "MEMORY", path: path.join(cwd, "MEMORY.md") },
    { title: "AGENTS", path: path.join(cwd, "AGENTS.md") },
    { title: "日記", path: path.join(cwd, "日記", `${todayStamp()}.md`) }
  ];

  let found = false;
  for (const file of files) {
    const content = await readOptional(file.path);
    if (content) {
      found = true;
      sections.push(`\n# ${file.title}\n${content.trim()}`);
    }
  }

  if (!found) {
    sections.push("\n請以繁體中文回覆，保持務實、清楚並遵守安全護欄。\n");
  }

  if (memoryContext?.trim()) {
    sections.push(`\n# 持久化會話記憶\n${memoryContext.trim()}`);
  }

  sections.push(`\n# 執行環境\n${NO_GUI_ENVIRONMENT_NOTICE}\n`);
  sections.push("\n請以繁體中文回覆。\n");
  return sections.join("\n");
}
