# Security Hardening Design

## Goals
- Sandbox 預設強制啟用，僅在明確參數下允許停用。
- Guardrails 採用規則 + 語義混合檢測，提升對 Prompt Injection 與敏感請求的阻擋能力。
- 工具輸出加入阻擋或遮罩機制，避免敏感資料回傳。
- Redaction 擴充敏感資訊與憑證偵測，降低日誌外洩風險。
- 對附件合成後的 prompt 進行最終長度與風險檢查。

## Architecture
- Sandbox profile 固定輸出為更嚴格的規則組合，包含全域禁止寫入、限定特定寫入路徑、限定 process exec。
- Guardrails pipeline：Length → Builtin → Semantic → Deny → Allow → Default。
- Tool output pipeline：evaluate guardrails → block or redactStrict → send summary。
- Prompt pipeline：compose attachments → final evaluate → send or reject。

## Components
- `src/sandbox-profile.ts`：sandbox 開關與 profile 生成。
- `src/sandbox.ts`：啟動 sandbox 流程與 profile 套用。
- `src/guardrails/guardrails.ts`：新增語義檢測與工具輸出防護。
- `src/util/redaction.ts`：擴充敏感模式與 strict redaction。
- `src/session/prompt.ts`：合成 prompt 與最終風險檢查。

## Data Flow
- Telegram 訊息 → 初步 guardrails → 合成附件 → 最終 guardrails → Copilot。
- Tool output → guardrails 判斷 → block 或 redactStrict → Telegram 回傳。

## Error Handling
- sandbox 啟動失敗仍回報 log，避免主程序 silent fail。
- guardrails 拒絕時回傳 ruleId/source，利於追蹤。

## Testing
- 新增 sandbox profile、guardrails semantic/工具輸出、redaction strict、prompt 合成長度檢查測試。
