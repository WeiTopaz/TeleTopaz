# 💎 TeleTopaz

以 TypeScript 實作的進階 AI 代理 Telegram 機器人，支援 GitHub Copilot SDK 與 Google Gemini CLI 雙供應商，具備智慧意圖路由（Auto-Routing）與安全沙盒機制。

## 特色

- **雙供應商支援**：同時整合 GitHub Copilot 與 Google Gemini，可依需求自由切換。
- **智慧路由 (Auto Mode)**：自動分析使用者意圖，簡單查詢使用輕量模型 (Router)，複雜任務切換至強力模型 (Core)，優化速度與成本。
- **安全持久化記憶**：以工作區為作用域保存最近對話脈絡，寫入前自動遮罩敏感資訊。
- **安全沙盒**：在 macOS 上透過 `sandbox-exec` 隔離執行環境，並嚴格限制檔案寫入權限。
- **人機協作護欄**：敏感操作（如寫入、刪除檔案）需使用者即時按鈕確認。
- **隱私優先**：內建敏感資訊遮蔽 (Redaction) 與 Prompt Injection 防護。

## 需求

- Node.js 22+
- macOS (推薦，支援沙盒與 Keychain) 或 Linux
- **Copilot**: 需具備 GitHub Copilot 訂閱
- **Gemini**: 需安裝並設定 `gemini` CLI 工具 (若要使用 Gemini 模型)

## 初始化

```bash
npm install
npm run setup:secrets
```

### 環境變數

| 變數 | 必要 | 說明 |
|---|---|---|
| `TELETOPAZ_BOT_TOKEN` | ✅ | Telegram Bot Token |
| `TELETOPAZ_OWNER_CHAT_ID` | ✅ | 擁有者的 Chat ID |
| `TELETOPAZ_OWNER_USER_ID` | ✅ | 擁有者的 User ID |
| `TELETOPAZ_DIRECTORY_PATTERNS` | ✅ | 逗號分隔的 Glob 模式，定義可選工作區與沙盒可寫入根目錄；未設定時 `npm start` 會直接拒絕啟動 |
| `TELETOPAZ_CERT_FINGERPRINTS` | — | 逗號分隔的 SHA-256 指紋（TLS pinning） |
| `TELETOPAZ_DATA_DIR` | — | App data 目錄；用於保存已遮罩的持久化會話記憶，預設為 `~/.teletopaz` |
| `TELETOPAZ_LOG_LEVEL` | — | Logger 等級，支援 `debug` / `info` / `warn` / `error` |
| `TELETOPAZ_LOG_DIR` | — | 自訂日誌輸出目錄，預設為專案下的 `logs/` |

> `npm run setup:secrets` 會把必要 secrets（Bot Token / Owner IDs）寫入 macOS Keychain；`TELETOPAZ_DIRECTORY_PATTERNS` 與 `TELETOPAZ_CERT_FINGERPRINTS` 這類非敏感啟動設定會寫入 TeleTopaz app data 下的 `runtime-config.json`。所有欄位都可以直接由環境變數覆蓋；舊版若曾把這兩個值存在 Keychain，啟動時會自動遷移一次。

## 執行

```bash
npm start
```

## 指令列表

| 指令 | 說明 |
|---|---|
| `/help` | 顯示說明與指令列表 |
| `/project` | 選擇工作目錄 (Workspace) |
| `/model` | 設定 AI 模型與路由模式 (Auto/Manual，顯示格式為 `ctcli:model` / `gmcli:model`) |
| `/info` (或 `/i`) | 檢視目前狀態、模型與資源使用量 |
| `/clear` | 清除對話歷史與附件圖片，並重啟工作階段 |
| `/quit` | 安全關閉機器人 |

### 目前內建模型

- `ctcli:gpt-5.4`
- `ctcli:gpt-5-mini`
- `ctcli:claude-opus-4.6`
- `ctcli:claude-sonnet-4.6`
- `gmcli:gemini-3.1-pro-preview`

> Auto Mode 預設會以 `ctcli:gpt-5-mini` 作為 Router、`gmcli:gemini-3.1-pro-preview` 作為 Core。

## AI 供應商設定

### 1. GitHub Copilot (預設)
本專案預設使用 `@github/copilot-sdk`。首次啟動時需依照 Log 指示進行裝置驗證 (Device Auth)。
若 GitHub CLI / Copilot agent runtime 升級後出現 `SDK protocol version mismatch`，請先執行 `npm install` 以同步專案內的 SDK 版本；目前相依已更新到支援 protocol v3 的 `@github/copilot-sdk` 版本線。

### 2. Google Gemini (選用)
若要使用 Gemini 模型 (如 `gmcli:gemini-3.1-pro-preview`)，需確保環境中可執行 `gemini` 指令：

1. 安裝 Gemini CLI Core：`npm install -g @google/gemini-cli-core` (或確保在 PATH 中)
2. 設定 ADC 憑證：`gcloud auth application-default login`
3. 在 Bot 中使用 `/model` 切換至 Gemini 系列模型，或在 Auto Mode 中將其設為 Core 模型。
4. 基於安全考量，Gemini 工作階段目前以 **read-only plan mode** 執行；若需要編輯、寫入或 shell 類工具，請改用 Copilot 模型。

## 安全機制

- **沙盒 (macOS)**：`npm start` 會強制以沙盒啟動；可寫入範圍僅限於 `TELETOPAZ_DIRECTORY_PATTERNS` 對應根目錄、系統暫存區、TeleTopaz app data 目錄及 Copilot / Gemini 設定檔。
- **讀取限制**：無需人工確認的讀取型工具（如 read / grep / glob / list）只允許存取目前選定工作區；對 `.env`、`.npmrc`、`.git-credentials`、`id_*` 等敏感檔名會直接拒絕。
- **操作確認**：工具執行 `write`、`delete`、`edit` 等高風險操作時，會發送 Telegram 按鈕要求確認。
- **Guardrails**：
    - 拒絕未經授權的目錄存取。
    - 過濾 API Keys、私鑰等敏感資訊。
    - 偵測 Prompt Injection 攻擊。
- **持久化記憶**：最近對話脈絡會先經 `redactStrict` 遮罩後，再寫入 app data 目錄，不寫回使用者工作區。

## 專案結構

- `src/bot.ts`: 機器人核心邏輯與訊息處理
- `src/session/`: 對話狀態、Prompt 組裝與 Persona 管理
- `src/session/memory-store.ts`: 已遮罩的持久化會話記憶
- `src/gemini/`: Gemini CLI 封裝實作
- `src/copilot/`: Copilot SDK 整合
- `src/guardrails/`: 安全護欄規則與評估

## Acknowledgements

This project was inspired by doggy8088's MIT-licensed "telegram-copilot-bot" course material.
This codebase is a clean-room reimplementation and does not reuse original source code.
