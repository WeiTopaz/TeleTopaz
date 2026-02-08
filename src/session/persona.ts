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

export async function buildPersonaPrompt(cwd: string): Promise<string> {
  const sections: string[] = [];
  sections.push(`你是 GitHub Copilot SDK 的代理。工作目錄：${cwd}`);

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

  sections.push("\n請以繁體中文回覆。\n");
  return sections.join("\n");
}
