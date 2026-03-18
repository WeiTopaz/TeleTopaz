# 💎 TeleTopaz — 測試計畫

> **版本**：0.4.0
> **最後更新**：2026-03-18
> **測試框架**：Vitest 4.0.18
> **參照文件**：[spec.md](../spec.md)

---

## 目錄

1. [測試策略概觀](#1-測試策略概觀)
2. [測試環境與框架](#2-測試環境與框架)
3. [現有測試覆蓋](#3-現有測試覆蓋)
4. [覆蓋缺口分析](#4-覆蓋缺口分析)
5. [建議新增測試](#5-建議新增測試)
6. [Mock 物件規範](#6-mock-物件規範)
7. [測試資料策略](#7-測試資料策略)
8. [執行與 CI 指引](#8-執行與-ci-指引)
9. [版本變更紀錄](#9-版本變更紀錄)

---

## 1. 測試策略概觀

### 1.1 測試目標

- 確保所有公開 API 與核心邏輯的正確性
- 驗證安全機制（沙盒、護欄、遮蔽、權限）的有效性
- 確保雙供應商整合（Copilot / Gemini）行為一致
- 防止回歸錯誤影響現有功能

### 1.2 測試金字塔

```
        ╱ ╲
       ╱ E2E ╲         （尚未建立）
      ╱───────╲
     ╱ 整合測試  ╲       35 個測試檔案
    ╱─────────────╲
   ╱   單元測試     ╲    35 個測試檔案（含整合特性）
  ╱─────────────────╲
```

目前專案以「單元 + 整合混合測試」為主，部分測試使用真實檔案系統操作（如 `directories.test.ts`、`session-memory.test.ts`）。

### 1.3 測試分類

| 分類 | 測試數量 | 涵蓋模組 |
|------|----------|----------|
| 核心 Bot 邏輯 | 14 個檔案 / 67 個案例 | `bot.ts` 各面向 |
| AI 供應商整合 | 5 個檔案 / 13 個案例 | `copilot/sdk.ts`, `gemini/sdk.ts`, `claude/sdk.ts` |
| 安全機制 | 3 個檔案 / 17 個案例 | `guardrails/`, `sandbox*.ts` |
| 設定管理 | 4 個檔案 / 13 個案例 | `config/*` |
| 會話管理 | 3 個檔案 / 9 個案例 | `session/*` |
| 工具程式 | 5 個檔案 / 28 個案例 | `util/*` |
| 熱重啟 | 1 個檔案 / 4 個案例 | `restart.ts` |

---

## 2. 測試環境與框架

### 2.1 框架設定

**框架**：Vitest 4.0.18  
**設定檔**：`vitest.config.ts`

```typescript
// vitest.config.ts
{
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    clearMocks: true
  }
}
```

### 2.2 執行指令

| 指令 | 說明 |
|------|------|
| `npm test` | 執行所有測試（單次） |
| `npm run test:watch` | 監視模式（開發用） |
| `npm test -- {檔名}` | 執行特定測試檔 |
| `npm test -- --coverage` | 含覆蓋率報告 |

### 2.3 環境需求

- Node.js 22+
- 測試環境：`node`（非 browser）
- Mock 策略：`clearMocks: true`（每次測試後自動清除）

---

## 3. 現有測試覆蓋

### 3.1 核心 Bot 邏輯 (14 個檔案)

#### 3.1.1 `bot-allow-all.test.ts` — 自動批准模式

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | toggles allowAll on and off | `allowAll` 狀態正確切換 |
| 2 | sends appropriate status message on toggle | 中文狀態訊息正確 |
| 3 | auto-approves interactive approval when allowAll is true | 開啟時自動批准工具 |
| 4 | shows confirmation prompt when allowAll is false | 關閉時顯示 ✅/❌ 按鈕 |

**測試對象**：`handleAllowAllToggle()`, `requestInteractiveApproval()`

---

#### 3.1.2 `bot-newproject.test.ts` — 新建專案指令

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | creates a new project directory successfully | workDir 已設、名稱合法、目錄不存在 → 成功建立 + 確認訊息 |
| 2 | rejects names with illegal characters | 包含空格或特殊字元 → 拒絕 + 錯誤訊息 |
| 3 | rejects empty name | 未提供名稱 → 錯誤訊息 |
| 4 | rejects when directory already exists | 同名目錄已在工作區 → 錯誤訊息 |
| 5 | prompts to select project when workDir is not set | workDir 為 undefined → 提示先選擇專案 |
| 6 | rejects names with path traversal characters | 含 `../` 等路徑穿越字元 → 拒絕 |

**測試對象**：`handleNewProject()`

---

#### 3.1.3 `bot-silent-mode.test.ts` — 安靜模式

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | defaults silentMode to true | `silentMode` 預設為 `true` |
| 2 | toggles silentMode off then on | 切換狀態正確 |
| 3 | sends appropriate status message on toggle | 切換訊息正確 |
| 4 | clears anchor when silent mode is turned off | 關閉時清除錨點 |
| 5 | creates anchor on first silentSend call | 首次呼叫建立錨點 |
| 6 | edits anchor on subsequent calls | 後續呼叫編輯錨點 |
| 7 | passes replyTo when creating anchor | replyTo 正確傳遞 |
| 8 | resets anchor in preparePromptDispatch | 新一輪對話清除錨點 |
| 9 | resets anchor in handleClear | clear 時清除錨點 |
| 10 | uses silentSend when silent mode is on (sendDoneNotice) | Done 通知使用 silentSend |
| 11 | includes prompt summary when no assistant message received | 無 AI 回覆時附加提示詞摘要 |
| 12 | falls back to normal behavior when silent mode is off | 關閉時使用一般行為 |
| 13 | uses silentSend without keyboard in silent mode (handleToolStart) | 工具開始不發送按鈕 |
| 14 | tracks tool with anchor messageId in silent mode | 工具追蹤使用錨點 ID |
| 15 | sends with keyboard in normal mode | 一般模式發送按鈕 |
| 16 | edits anchor instead of tool message in silent mode (handleToolComplete) | 工具完成編輯錨點 |
| 17 | buildStatusBlock includes silent mode line | 狀態顯示安靜模式資訊 |
| 18 | shows 關閉 when silent mode is off | 狀態正確顯示「關閉」 |

**測試對象**：`handleSilentToggle()`, `silentSend()`, `preparePromptDispatch()`, `handleClear()`, `sendDoneNotice()`, `handleToolStart()`, `handleToolComplete()`, `buildStatusBlock()`

---

#### 3.1.4 `proactive-rebuild-notice.test.ts` — 主動重建通知去重複

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | 首次重建：發送新訊息並附加 (1)，儲存 lastProactiveRebuildNotice | 新訊息 + 計數 1 |
| 2 | 連續第二次重建：編輯原訊息為 (2)，更新計數 | 編輯計數遞增 |
| 3 | 連續第三次重建：計數繼續遞增至 (3) | 計數正確累積 |
| 4 | safeSend 失敗（回傳 undefined）：不儲存 lastProactiveRebuildNotice | 失敗不更新狀態 |
| 5 | 靜默時段：不發送訊息，lastProactiveRebuildNotice 保持不變 | 靜默時段不發送 |
| 6 | 靜默時段：有既存通知時，lastProactiveRebuildNotice 維持原值不被更動 | 既有狀態保留 |
| 7 | 使用者傳送訊息時，清除 lastProactiveRebuildNotice | 使用者訊息後清除 |
| 8 | 使用者傳送訊息後再次觸發重建：重新發送新訊息 (1) | 清除後重新計數 |
| 9 | getOrCreateState 建立的新狀態，lastProactiveRebuildNotice 預設為 undefined | 初始值正確 |

**測試對象**：`checkSessionHealth()`, `handleMessage()`, `getOrCreateState()`

---

#### 3.1.5 `bot-auto-mode.test.ts` — 自動路由模式

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | does not create a concrete provider session during startup | 啟動時不預建 session |
| 2 | switches project in auto mode without creating session | 切換目錄不建 session |
| 3 | routes the first message after project selection | 首訊觸發分類 + session 建立 |

**測試對象**：Auto Mode 啟動、`setDirectory()`, `handleMessage()` 路由流程

---

#### 3.1.6 `bot-classifier.test.ts` — 意圖分類器

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | reuses the classifier client between messages | 分類器 client 跨訊息重用 |
| 2 | creates classifier sessions with tools denied | 分類器 session 禁用工具 |

**測試對象**：`classifyIntent()`, 分類器 client 生命週期

---

#### 3.1.7 `bot-memory.test.ts` — 記憶與會話建立

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | adds persisted memory context when creating session | 記憶注入系統提示詞 |
| 2 | passes built-in and workspace skill directories | Copilot skill 路徑 |
| 3 | uses read-only plan mode for Gemini sessions | Gemini 使用 plan 模式 |
| 4 | rejects workspace skills outside workspace | Symlink 穿越攻擊防護 |
| 5 | persists completed turns on session idle | 對話持久化 |

**測試對象**：`createSession()`, 技能路徑驗證, 記憶持久化

---

#### 3.1.8 `bot-model-display.test.ts` — 模型顯示 UI

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | shows auto routing config in status | Auto Mode 狀態格式 |
| 2 | uses auto pending label before first route | 待路由標籤 |
| 3 | renders unified model picker with CLI aliases | 統一選擇器 UI |
| 4 | keeps gmcli core models out of router picker | Router/Core 分離 |

**測試對象**：模型顯示格式、統一選擇器、Router/Core 篩選

---

#### 3.1.9 `bot-polling.test.ts` — 輪詢錯誤處理

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | deduplicates repeated transient polling errors | 15 秒窗口去重複 |

**測試對象**：`poll()` 暫時性網路錯誤處理

---

#### 3.1.10 `bot-reaction.test.ts` — 表情反應

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | retries reaction with chat-supported emojis after REACTION_INVALID | 表情重試機制 |

**測試對象**：`handleToolComplete()` 表情反應設定

---

#### 3.1.11 `bot-session-resilience.test.ts` — 會話韌性與復原

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | rebuilds a disposed session and asks before resending the original prompt | 被動復原流程（偵測 connection disposed → 重建 session → 詢問重送） |
| 2 | resends the stored prompt after passive recovery confirmation without routing again | 被動復原後重送不重跑分類器 |
| 3 | proactively rebuilds stale sessions without talking to the LLM | 主動偵測閒置超時 → 自動重建（不消耗 LLM），固定於活躍時段 |
| 4 | suppresses proactive rebuild notification during quiet hours (00:00–07:59 UTC+8) | 靜默時段仍重建 session 但不發送通知 |

**測試對象**：`handleDisconnectedSession()`, `checkSessionHealth()`, `isQuietHours()`, `PendingRecovery` 流程

---

#### 3.1.12 `bot-startup-logging.test.ts` — 啟動日誌安全

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | does not log full allowed directories or owner chat id | 敏感資訊不記入日誌 |

**測試對象**：`start()` 日誌輸出安全性

---

#### 3.1.13 `bot-tool-permissions.test.ts` — 工具權限

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | denies read tools outside workspace | 工作區外讀取拒絕 |
| 2 | denies secret-like files inside workspace | `.env` 等檔案拒絕 |
| 3 | allows normal read tools within workspace | 正常讀取允許 |
| 4 | permission handler denies out-of-workspace reads | 權限處理器 — 拒絕 |
| 5 | permission handler approves safe workspace reads | 權限處理器 — 批准 |

**測試對象**：`onPreToolUse` hook, `onPermissionRequest` 處理器

---

#### 3.1.14 `bot-welcome-error-propagation.test.ts` — 歡迎訊息錯誤

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | logs welcome failure instead of success | 歡迎訊息傳送失敗正確記錄 |

**測試對象**：`start()` 歡迎訊息錯誤傳播

---

### 3.2 AI 供應商整合 (5 個檔案)

#### 3.2.1 `copilot-sdk-loader.test.ts` — SDK 載入

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | creates extensionless node shim | `vscode-jsonrpc/node` shim 建立 |
| 2 | keeps existing shim untouched | 已存在 shim 不覆蓋 |

---

#### 3.2.2 `copilot-sdk-protocol.test.ts` — 協定版本

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | rewrites protocol mismatches into actionable message | 版本不匹配錯誤本地化 |

---

#### 3.2.3 `copilot-sdk.test.ts` — SDK 會話

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | passes approvalMode to underlying SDK | `approvalMode` 傳遞 |
| 2 | passes onPermissionRequest to underlying SDK | 權限回調傳遞 |

---

#### 3.2.4 `gemini-sdk.test.ts` — Gemini CLI

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | hooks events and emits assistant.message + session.idle | 事件串流 |
| 2 | extracts onPreToolUse hook from options | Hook 擷取 |
| 3 | creates session without hooks gracefully | 無 hook 建立 |
| 4 | applies onPreToolUse to non-dangerous tools | 工具 hook 呼叫 |
| 5 | passes approval mode to Gemini CLI | CLI 旗標傳遞 |
| 6 | abort handles AbortController | 中止處理 |
| 7 | destroy handles AbortController | 銷毀處理 |

---

#### 3.2.5 `claude-sdk.test.ts` — Claude Code CLI

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | passes Claude home access settings to the CLI | `--add-dir ~/.claude`、`--settings` JSON 正確；`~/.claude/**` 讀取/編輯權限 |

**測試對象**：`ClaudeCodeSdkSession.spawnClaudeCodeCli()`, `buildClaudeHomeAccessSettings()`

---

### 3.3 安全機制 (3 個檔案)

#### 3.3.1 `guardrails.test.ts` — 護欄引擎

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | rejects long prompts | 長度限制 |
| 2 | rejects prompt injection phrases | 注入攻擊偵測 |
| 3 | rejects semantic requests for secrets | 語意分析 |
| 4 | blocks tool output that hits guardrails | 工具輸出阻擋 |
| 5 | allows long prompt when ignoring length | 長度忽略模式 |
| 6 | does not block long tool output due to length | 工具輸出不受長度限制 |
| 7 | does not block tool output with incidental action+target | 誤報防止 |
| 8 | still blocks tool output containing actual secrets | 真實密鑰仍阻擋 |

---

#### 3.3.2 `sandbox-profile.test.ts` — 沙盒設定檔

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | enables sandbox by default | 預設啟用 |
| 2 | forces sandbox even when env tries to disable | 無法停用 |
| 3 | builds profile with dynamic home paths and PTY | 動態路徑 + PTY |
| 4 | allows /dev/null for subprocesses that rely on it | 子程序 /dev/null 存取 |
| 5 | allows each pattern root without broadening | 不放大至共同祖先 |
| 6 | prefers pattern roots over selected child workDir | 模式優先 |
| 7 | omits project write rule when no workDir or patterns | 無目錄時不加規則 |

---

#### 3.3.3 `sandbox.test.ts` — 沙盒啟動

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | rejects startup when TELETOPAZ_DIRECTORY_PATTERNS empty | 空模式拒絕啟動 |
| 2 | accepts configured TELETOPAZ_DIRECTORY_PATTERNS | 有效模式接受 |

---

### 3.4 設定管理 (4 個檔案)

#### 3.4.1 `directories.test.ts` — 目錄存取控制

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | expands glob patterns | Glob 展開 |
| 2 | validates allowed directory | 允許目錄驗證 |
| 3 | rejects symlinks outside allowed root | Symlink 攻擊防護 |
| 4 | matches by canonical real path | 正規化路徑匹配 |

---

#### 3.4.2 `models.test.ts` — 模型設定

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | matches REF model inventory | 模型清單完整性 |
| 2 | loads provider-specific model lists | 供應商分離 |
| 3 | formats display entries with CLI aliases | 顯示格式 |
| 4 | accepts provider:model overrides for default | 預設模型覆寫 |

---

#### 3.4.3 `secrets.test.ts` — 密鑰管理

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | reads required secrets from keychain | Keychain 讀取 |
| 2 | prefers env vars before keychain | 環境變數優先 |

---

#### 3.4.4 `runtime-config.test.ts` — 執行時設定

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | persists non-secret settings | 設定持久化 |
| 2 | prefers env vars over stored settings | 環境變數優先 |
| 3 | hydrates from legacy loader and persists | 舊版遷移 |

---

### 3.5 會話管理 (3 個檔案)

#### 3.5.1 `persona.test.ts` — 人設提示詞

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | does not inline TOOLS.md into system prompt | TOOLS.md 排除（安全） |

---

#### 3.5.2 `prompt.test.ts` — 提示詞組裝

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | allows short prompt without attachments | 短提示詞通過 |
| 2 | splits long prompt into chunks without losing content | 分段不失資料 |
| 3 | composePrompt includes file path when available | 附件含檔案路徑時正確組合 |
| 4 | composePrompt falls back to inline label without filePath | 無檔案路徑時使用行內標籤 |
| 5 | allows composed prompt with attachments containing base64 data | Base64 附件不觸發護欄 |
| 6 | allows legitimate image analysis prompts with action+target words | 圖片分析提示詞不誤判 |

**測試對象**：`composePrompt()`, `buildPromptChunks()`, `evaluateComposedPrompt()`

---

#### 3.5.3 `session-memory.test.ts` — 持久化記憶

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | stores redacted entries and builds prompt context | 遮蔽 + 脈絡建構 |
| 2 | keeps only recent entries and isolates workspaces | 上限 + 工作區隔離 |

---

### 3.6 熱重啟 (1 個檔案)

#### 3.6.1 `restart.test.ts` — 熱重啟狀態管理

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | loadRestartState returns null when no file exists | 缺檔處理 |
| 2 | saveRestartState and loadRestartState roundtrip | 持久化來回一致 |
| 3 | clearRestartState removes the state file | 狀態清除 |
| 4 | saveRestartState overwrites existing state | 覆寫行為 |

**測試對象**：`saveRestartState()`, `loadRestartState()`, `clearRestartState()`

---

### 3.7 工具程式 (5 個檔案)

#### 3.7.1 `errors.test.ts` — 錯誤分類

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | detects connection disposed | 連線中斷偵測 |
| 2 | extracts transient network summaries | 網路錯誤摘要 |
| 3 | suppresses repeated log entries | 去重複日誌 |

---

#### 3.7.2 `format.test.ts` — 格式化

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | parses 1-based index | 索引轉換 |
| 2 | formats json | JSON 美化 |

---

#### 3.7.3 `logger.test.ts` — 日誌系統

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | prefixes console output with timestamp and level | 時間戳 + 等級 |
| 2 | writes to configured log directory and flushes | 檔案寫入 + flush |

---

#### 3.7.4 `markdown.test.ts` — Markdown 轉換

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | escapes underscores in tool names (snake_case) | snake_case 跳脫 |
| 2 | escapes multiple underscores in identifiers | 多重底線跳脫 |
| 3 | converts **bold** to *bold* | 粗體轉換 |
| 4 | converts ~~strikethrough~~ to ~strikethrough~ | 刪除線轉換 |
| 5 | preserves _italic_ at word boundaries | 斜體保留 |
| 6 | does not treat underscores inside words as italic | 詞內底線不誤判 |
| 7 | escapes dots, parens, and other MarkdownV2 special chars | 特殊字元跳脫 |
| 8 | converts # heading to bold | 標題轉粗體 |
| 9 | handles mixed tool output with underscores and formatting | 混合工具輸出 |
| 10 | preserves code blocks without extra escaping | 程式碼區塊保留 |
| 11 | preserves inline code without extra escaping | 行內程式碼保留 |
| 12 | handles empty string | 空字串處理 |
| 13 | handles plain text with no special characters | 純文字處理 |
| 14 | handles __underline__ formatting | 底線格式 |
| 15 | produces valid MarkdownV2 for tool names in status messages | 工具名稱狀態訊息 |
| 16 | returns single chunk for short messages | 短訊不分割 |
| 17 | splits at newline within 80% boundary | 長訊在換行處分割 |

---

#### 3.7.5 `redaction.test.ts` — 敏感資料遮蔽

| # | 測試案例 | 驗證重點 |
|---|----------|----------|
| 1 | redacts tokens and keys | API 金鑰遮蔽 |
| 2 | redacts PEM blocks | 私鑰遮蔽 |
| 3 | redacts JWT and Slack tokens | JWT / Slack 遮蔽 |
| 4 | redacts emails only in strict mode | 嚴格模式 Email |

---

## 4. 覆蓋缺口分析

### 4.1 完全無測試的模組

| 模組 | 檔案 | 嚴重程度 | 說明 |
|------|------|----------|------|
| Telegram API 封裝 | `src/telegram/api.ts` | 🔴 高 | 所有 Bot API 呼叫的基礎，含 TLS pinning、錯誤處理、格式降級 |
| PTY 模組 | `src/pty/*.ts` | 🔴 高 | 新增的偽終端機驅動模組，含 runner/ansi-parser/completion-detector/human-typist 等 |
| Gemini PTY 工作階段 | `src/gemini/pty-session.ts` | 🔴 高 | 新供應商實作，尚無任何測試 |
| 用量追蹤 | `src/services/quota.ts` | 🟡 中 | 配額檢查、用量記錄、跨日統計 |
| TLS 憑證釘選 | `src/util/tls.ts` | 🟡 中 | 指紋解析、憑證驗證 |
| 圖片處理 | `src/util/images.ts` | 🟡 中 | sharp 重新編碼、EXIF 旋轉 |
| App Data 目錄 | `src/util/app-data.ts` | 🟢 低 | 路徑解析邏輯簡單 |
| 會話圖示 | `src/session/emoji.ts` | 🟢 低 | 圖示池選取邏輯簡單 |
| 進入點 | `src/index.ts` | 🟢 低 | 薄層，主要串接已測試模組 |

### 4.2 測試不足的模組

| 模組 | 現有測試 | 缺口 | 嚴重程度 |
|------|----------|------|----------|
| `bot.ts` — 事件分發 | 間接測試 | `handleEvent()` 各事件型別的直接測試 | 🟡 中 |
| `bot.ts` — 訊息傳送 | 無直接測試 | `safeSend()`, `editMessageSafe()` 格式降級邏輯 | 🟡 中 |
| `bot.ts` — 圖片處理 | 無 | `handleImages()` 大小限制、重編碼、附件管理 | 🟡 中 |
| `bot.ts` — 指令處理 | 部分 | `/help`, `/project`, `/info`, `/clear`, `/quit`, `/router` 直接測試 | 🟡 中 |
| `bot.ts` — 回調路由 | 無直接測試 | `handleCallback()` 各回調 data 路由 | 🟡 中 |
| `bot.ts` — 關閉流程 | 無 | `shutdown()` session 銷毀、client 停止、日誌 flush | 🟡 中 |
| `copilot/sdk.ts` — 啟動 | 無 | `start()` SDK 載入、裝置驗證 | 🟡 中 |
| `copilot/sdk.ts` — 模型查詢 | 無 | `queryProviderInfo()` 模型清單解析 | 🟢 低 |
| `claude/sdk.ts` — 重試邏輯 | 無 | 退避延遲、錯誤分類、最大嘗試 | 🟡 中 |
| `claude/sdk.ts` — stream-json 解析 | 無 | tool_use/tool_result 事件解析、result 提取 | 🟡 中 |
| `gemini/sdk.ts` — 重試邏輯 | 無 | 退避延遲、錯誤分類、最大嘗試 | 🟡 中 |
| `gemini/sdk.ts` — 串流解析 | 部分 | 完整 JSON 串流解析、畸形輸入處理 | 🟡 中 |
| `guardrails/guardrails.ts` — 自訂規則 | 無 | `loadGuardrails()` 載入自訂 `guardrails.json` | 🟢 低 |
| `restart.ts` — Git 操作 | 無 | `getGitInfo()`, `performGitRollback()` 依賴 `execSync` 執行 Git 指令，無單元測試 | 🟢 低 |
| `persona.ts` — 完整建構 | 部分 | MEMORY.md + AGENTS.md + 日記組合、降級邏輯 | 🟢 低 |
| `util/redaction.ts` — 遞迴遮蔽 | 無 | `redactUnknown()`, `redactObject()` | 🟢 低 |

### 4.3 覆蓋率摘要

```
模組覆蓋狀態：

src/bot.ts             ████████████████░░░░  80%  (14 測試檔，含安靜模式 + 通知去重複)
src/copilot/sdk.ts     ████████░░░░░░░░░░░░  40%  (3 檔，缺啟動/查詢)
src/gemini/sdk.ts      ██████████████░░░░░░  70%  (7 案例，缺重試/串流)
src/gemini/pty-session.ts ░░░░░░░░░░░░░░░░░░░░   0%  ⚠️
src/claude/sdk.ts      ████░░░░░░░░░░░░░░░░  20%  (1 案例，缺重試/串流解析)
src/pty/               ░░░░░░░░░░░░░░░░░░░░   0%  ⚠️
src/guardrails/        ██████████████████░░  90%  (8 案例，覆蓋良好)
src/sandbox*.ts        ████████████████░░░░  80%  (9 案例)
src/config/            ██████████████████░░  90%  (13 案例)
src/session/           ██████████████░░░░░░  70%  (9 案例，缺 emoji)
src/restart.ts         ████████████████░░░░  80%  (4 案例，缺 getGitInfo/performGitRollback)
src/util/              ████████████████░░░░  80%  (28 案例，缺 tls/images)
src/telegram/          ░░░░░░░░░░░░░░░░░░░░   0%  ⚠️
src/services/          ░░░░░░░░░░░░░░░░░░░░   0%  ⚠️
```

---

## 5. 建議新增測試

### 5.1 優先排序

以下依 **風險 × 影響** 排序：

#### 🔴 P0 — 高優先（核心功能 + 安全）

| ID | 測試檔案 | 測試目標 | 建議案例數 |
|----|----------|----------|-----------|
| T01 | `telegram-api.test.ts` | `TelegramApi` 封裝 | 10–12 |
| T02 | `tls.test.ts` | TLS 憑證釘選 | 5–6 |
| T03 | `bot-event-dispatch.test.ts` | 事件分發流程 | 6–8 |

#### 🟡 P1 — 中優先（功能完整性）

| ID | 測試檔案 | 測試目標 | 建議案例數 |
|----|----------|----------|-----------|
| T04 | `quota.test.ts` | 用量追蹤 | 5–6 |
| T05 | `bot-commands.test.ts` | 指令處理 | 6–8 |
| T06 | `bot-image-handling.test.ts` | 圖片附件處理 | 4–5 |
| T07 | `bot-send-format.test.ts` | 訊息傳送與格式降級 | 4–5 |
| T08 | `gemini-retry.test.ts` | Gemini 重試與逾時 | 4–5 |

#### 🟢 P2 — 低優先（輔助功能）

| ID | 測試檔案 | 測試目標 | 建議案例數 |
|----|----------|----------|-----------|
| T09 | `images.test.ts` | `reencodePhoto()` | 3–4 |
| T10 | `emoji.test.ts` | 會話圖示選取 | 2–3 |
| T11 | `app-data.test.ts` | App Data 路徑解析 | 2–3 |
| T12 | `bot-shutdown.test.ts` | 關閉流程 | 3–4 |
| T13 | `redaction-recursive.test.ts` | 遞迴遮蔽 | 3–4 |

### 5.2 詳細測試案例設計

#### T01: `telegram-api.test.ts` — Telegram API 封裝 🔴

```
describe("TelegramApi")
  ├── "sends message with MarkdownV2 format"
  ├── "falls back to plain text when MarkdownV2 fails"
  ├── "getUpdates uses long polling with correct offset"
  ├── "editMessageText attempts MarkdownV2 first"
  ├── "editMessageTextPlain sends without parse_mode"
  ├── "answerCallbackQuery returns boolean"
  ├── "setMessageReaction sends correct emoji payload"
  ├── "getFile returns file metadata"
  ├── "getChat returns chat info with available_reactions"
  ├── "downloadFile enforces maxBytes limit"
  ├── "applies TLS certificate pinning"
  └── "throws on non-ok API response"
```

**Mock 策略**：使用 `vi.mock("node:https")` 或 `vi.mock("node:http")` 模擬 HTTP 回應。

---

#### T02: `tls.test.ts` — TLS 憑證釘選 🔴

```
describe("TLS utilities")
  ├── "normalizeFingerprint removes non-hex and uppercases"
  ├── "parseFingerprints splits comma-separated values"
  ├── "parseFingerprints returns empty for undefined"
  ├── "buildCheckServerIdentity rejects wrong hostname"
  ├── "buildCheckServerIdentity accepts matching fingerprint"
  └── "buildCheckServerIdentity rejects non-matching fingerprint"
```

**Mock 策略**：建構假的 `PeerCertificate` 物件。

---

#### T03: `bot-event-dispatch.test.ts` — 事件分發 🔴

```
describe("event dispatch")
  ├── "handles assistant.message and sends to Telegram"
  ├── "deduplicates identical assistant messages by hash"
  ├── "handles tool.execution_start and creates tracking"
  ├── "handles tool.execution_complete with success emoji"
  ├── "handles tool.execution_complete with error emoji"
  ├── "handles session.idle and persists memory"
  ├── "processes next pending task on session.idle"
  └── "queues events when already dispatching"
```

**Mock 策略**：呼叫 `enqueueEvent()` 並驗證 Telegram API 呼叫。

---

#### T04: `quota.test.ts` — 用量追蹤 🟡

```
describe("QuotaService")
  ├── "increments daily count"
  ├── "resets daily count on new day"
  ├── "tracks monthly aggregation"
  ├── "tracks per-model breakdown"
  ├── "checkQuota returns current stats"
  └── "handles missing stats file gracefully"
```

**Mock 策略**：使用真實檔案系統 + 暫存目錄。

---

#### T05: `bot-commands.test.ts` — 指令處理 🟡

```
describe("command handling")
  ├── "/help sends welcome with nav keyboard"
  ├── "/project shows directory list"
  ├── "/info displays status with model and quota"
  ├── "/clear resets session and attachments"
  ├── "/clear preserves model and workDir"
  ├── "/quit triggers shutdown on valid message date"
  ├── "/quit ignores old messages (date < startTimestamp)"
  └── "unknown command is ignored"
```

---

#### T06: `bot-image-handling.test.ts` — 圖片附件 🟡

```
describe("image handling")
  ├── "downloads and re-encodes photo as JPEG"
  ├── "rejects photo exceeding MAX_ATTACHMENT_BYTES"
  ├── "enforces MAX_ATTACHMENTS limit"
  ├── "stores attachment as base64 data URL"
  └── "handles download failure gracefully"
```

**Mock 策略**：模擬 `TelegramApi.getFile()` + `downloadFile()` + `sharp`。

---

#### T07: `bot-send-format.test.ts` — 訊息格式降級 🟡

```
describe("message formatting")
  ├── "safeSend uses MarkdownV2 by default"
  ├── "safeSend falls back to plain text on parse error"
  ├── "safeSend splits messages exceeding 4096 chars"
  ├── "editMessageSafe falls back and resends on failure"
  └── "prepareOutgoingText adds header with session icon"
```

---

#### T08: `gemini-retry.test.ts` — Gemini 重試 🟡

```
describe("Gemini retry logic")
  ├── "retries on GOAWAY error with backoff"
  ├── "retries on connection reset"
  ├── "retries up to 3 times"
  ├── "throws after max retries exceeded"
  └── "applies backoff delays [1s, 2s, 5s]"
```

**Mock 策略**：模擬 `child_process.spawn()` 以特定退出碼/錯誤結束。

---

#### T09–T13：低優先測試（略述）

**T09 `images.test.ts`**：驗證 `reencodePhoto()` EXIF 旋轉、JPEG 品質、空/損壞輸入。Mock `sharp`。

**T10 `emoji.test.ts`**：驗證 `pickIcon()` 排除已使用圖示、池耗盡時隨機選取。

**T11 `app-data.test.ts`**：驗證 `resolveAppDataDir()` 環境變數覆寫、預設路徑。

**T12 `bot-shutdown.test.ts`**：驗證 `shutdown()` 銷毀 session + 停止 client + flush 日誌的逾時行為。

**T13 `redaction-recursive.test.ts`**：驗證 `redactUnknown()` 處理巢狀物件、Error、陣列、循環參考。

---

## 6. Mock 物件規範

### 6.1 標準 Mock 套件

以下 Mock 物件在多個測試檔案中重複使用，建議抽取為共享 fixture：

#### TelegramApi Mock

```typescript
function createMockApi(): TelegramApi {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1, date: 0, chat: { id: 1, type: "private" } }),
    editMessageText: vi.fn().mockResolvedValue({}),
    editMessageTextPlain: vi.fn().mockResolvedValue({}),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    setMessageReaction: vi.fn().mockResolvedValue(true),
    getUpdates: vi.fn().mockResolvedValue([]),
    getFile: vi.fn().mockResolvedValue({ file_id: "f1", file_path: "photos/1.jpg" }),
    getChat: vi.fn().mockResolvedValue({ id: 1, type: "private" }),
    downloadFile: vi.fn().mockResolvedValue(Buffer.from("fake-image")),
  } as unknown as TelegramApi;
}
```

#### AiClient Mock

```typescript
function createMockClient(): AiClient {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue(createMockSession()),
    queryProviderInfo: vi.fn().mockResolvedValue({
      version: "1.0",
      models: ["gpt-5-mini"],
    }),
  };
}
```

#### AiSession Mock

```typescript
function createMockSession(): AiSession {
  return {
    onEvent: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    sendAndWait: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
  };
}
```

### 6.2 Mock 最佳實踐

| 原則 | 說明 |
|------|------|
| 最小 Mock | 僅 Mock 外部依賴（HTTP、檔案系統、子程序），不 Mock 內部邏輯 |
| 真實檔案系統 | 安全測試（目錄、記憶、設定）應使用 `fs.mkdtemp` 建立暫存目錄 |
| 清理 | 使用 `afterEach` / `afterAll` 清理暫存目錄與 Mock 狀態 |
| 型別安全 | Mock 物件應透過 `as unknown as Type` 確保介面一致 |

---

## 7. 測試資料策略

### 7.1 敏感資料

| 類型 | 測試用假值 |
|------|----------|
| Bot Token | `"1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZ_fake_token"` |
| Chat ID | `1` 或 `12345` |
| User ID | `1` 或 `67890` |
| API Key | `"sk-1234567890abcdef1234567890abcdef"` |
| PEM 私鑰 | `"-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----"` |
| JWT | `"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.fake_signature"` |

> **重要**：絕不使用真實密鑰或生產環境資料進行測試。

### 7.2 Telegram 訊息

```typescript
const SAMPLE_MESSAGE: TelegramMessage = {
  message_id: 42,
  date: Math.floor(Date.now() / 1000),
  chat: { id: 1, type: "private", first_name: "Test" },
  from: { id: 1, first_name: "Test", is_bot: false },
  text: "Hello, TeleTopaz!",
};
```

### 7.3 護欄政策

```typescript
const TEST_POLICY: GuardrailPolicy = {
  version: 1,
  maxPromptLength: 4096,
  denyRules: [],
  allowRules: [],
};
```

### 7.4 檔案系統

- 使用 `os.tmpdir()` + `fs.mkdtemp("teletopaz-test-")` 建立隔離暫存目錄
- 測試結束後使用 `fs.rm(tmpDir, { recursive: true, force: true })` 清理
- 不依賴專案目錄下的固定路徑

---

## 8. 執行與 CI 指引

### 8.1 本地執行

```bash
# 完整測試
npm test

# 監視模式（開發中）
npm run test:watch

# 特定模組
npm test -- tests/guardrails.test.ts

# 含覆蓋率
npm test -- --coverage

# 只跑失敗的測試
npm test -- --reporter=verbose --bail=1
```

### 8.2 CI 管線建議

```yaml
# .github/workflows/test.yml（建議範例）
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: macos-latest    # 沙盒測試需 macOS
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm run build
      - run: npm test -- --coverage
```

### 8.3 測試命名慣例

| 層面 | 慣例 |
|------|------|
| 檔案名稱 | `{模組名稱}.test.ts` 或 `{模組}-{面向}.test.ts` |
| describe 區塊 | 以模組或類別名稱命名 |
| it/test 名稱 | 以行為描述命名，英文撰寫 |
| 排列 | 先 happy path，後 edge case / error case |

### 8.4 效能考量

| 項目 | 建議 |
|------|------|
| 平行執行 | Vitest 預設平行執行測試檔，無需額外設定 |
| 暫存清理 | 確保 `afterAll` 清理暫存目錄，避免磁碟空間洩漏 |
| Fake Timers | 使用 `vi.useFakeTimers()` 避免真實延遲（如 polling 迴圈） |
| Mock 復原 | `clearMocks: true` 已設定，無需手動復原 |

---

## 9. 版本變更紀錄

| 版本 | 日期 | 變更說明 |
|------|------|----------|
| 0.4.0 | 2026-03-18 | 新增 `bot-silent-mode.test.ts`（18 案例）、`proactive-rebuild-notice.test.ts`（9 案例）、`claude-sdk.test.ts`（1 案例）；總測試檔 32→35；總案例數 138→148；核心 Bot 邏輯 12→14 檔；AI 供應商整合 4→5 檔；新增 PTY 模組與 `gemini/pty-session.ts` 覆蓋缺口說明；`claude/sdk.ts` 納入測試不足模組；`bot.ts` 覆蓋率估計提升至 80% |
| 0.3.0 | 2026-03-15 | 新增 `bot-newproject.test.ts`（6 案例）；核心 Bot 邏輯 11→12 檔；總案例數 132→138；章節重新編號 |
| 0.2.4 | 2026-03-14 | 新增靜默時段測試（`bot-session-resilience.test.ts` 3→4 案例）；總案例數 113→114 |
| 0.2.3 | 2026-03-14 | 完整校驗：逐一比對 31 檔 / 113 案例與原始碼，確認測試名稱、計數、覆蓋缺口分析及建議新增測試均無遺漏或幻覺 |
| 0.2.2 | 2026-03-14 | 全面比對 31 檔 / 113 案例，確認所有測試案例名稱、計數與覆蓋缺口分析均與原始碼一致，無幻覺 |
| 0.2.1 | 2026-03-14 | 補齊 `restart.ts` 覆蓋缺口（`getGitInfo`、`performGitRollback` 無單元測試）；調整 restart.ts 覆蓋率估計（90%→80%） |
| 0.2.0 | 2026-03-14 | 更新至 31 個測試檔 / 113 個案例；新增 `bot-session-resilience.test.ts`、`restart.test.ts` 章節；更新 `prompt.test.ts`（2→6）、`sandbox-profile.test.ts`（6→7）、`markdown.test.ts`（15→17）案例數；更新覆蓋缺口分析 |
| 0.1.0 | 2026-03-11 | 初始測試計畫，涵蓋 29 個現有測試 + 13 組建議新增測試 |

> 本文件應隨測試新增或修改時同步更新。每次新增測試檔案或重大測試策略調整時，請在此表新增一行紀錄。
