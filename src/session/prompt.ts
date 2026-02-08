import { evaluatePromptIgnoringLength } from "../guardrails/guardrails.js";
import type { GuardrailDecision, GuardrailPolicy } from "../guardrails/types.js";
import type { Attachment } from "./state.js";

export function composePrompt(prompt: string, attachments: Attachment[]): string {
  if (!attachments.length) return prompt;
  const list = attachments.map((a, i) => `${i + 1}. ${a.dataUrl}`).join("\n");
  return `${prompt}\n\n附件圖片：\n${list}`;
}

export type PromptChunks = {
  chunks: string[];
  total: number;
};

export function buildPromptChunks(prompt: string, maxLength: number): PromptChunks {
  if (maxLength <= 0) return { chunks: [], total: 0 };
  if (prompt.length <= maxLength) return { chunks: [prompt], total: 1 };

  const headerFor = (index: number, total: number) => `[PROMPT PART ${index}/${total}]\n`;
  const minimalHeaderLen = headerFor(1, 1).length;
  if (maxLength <= minimalHeaderLen + 1) {
    const chunks: string[] = [];
    for (let start = 0; start < prompt.length; start += maxLength) {
      chunks.push(prompt.slice(start, Math.min(prompt.length, start + maxLength)));
    }
    return { chunks, total: chunks.length };
  }
  let total = Math.ceil(prompt.length / Math.max(1, maxLength - headerFor(1, 1).length));
  while (true) {
    const headerLen = headerFor(1, total).length;
    const sliceSize = Math.max(1, maxLength - headerLen);
    const recalculated = Math.ceil(prompt.length / sliceSize);
    if (recalculated === total) break;
    total = recalculated;
  }

  const headerLen = headerFor(1, total).length;
  const sliceSize = Math.max(1, maxLength - headerLen);
  const chunks: string[] = [];

  for (let index = 0; index < total; index++) {
    const start = index * sliceSize;
    const end = Math.min(prompt.length, start + sliceSize);
    const header = headerFor(index + 1, total);
    const body = prompt.slice(start, end);
    chunks.push(`${header}${body}`);
  }

  return { chunks, total };
}

export function evaluateComposedPrompt(
  policy: GuardrailPolicy,
  prompt: string,
  attachments: Attachment[]
): GuardrailDecision {
  const combined = composePrompt(prompt, attachments);
  return evaluatePromptIgnoringLength(policy, combined);
}
