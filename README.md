# 💎 TeleTopaz (Copilot SDK / Gemini CLI)

以 TypeScript 實作的 AI 代理 Telegram 機器人，支援 GitHub Copilot SDK 與 Google Gemini CLI 雙供應商，依照 `functional-specification.md` 設計。

## 需求

- Node.js 22+
- `@github/copilot-sdk`（或 `@github/copilot-cli-sdk`）— Copilot 供應商
- `@google/gemini-cli-core`（選用）— Gemini 供應商，使用 ADC 驗證
- macOS 上需可使用 Keychain（透過 `keytar` 存取）

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
| `TELETOPAZ_DIRECTORY_PATTERNS` | ✅ | 逗號分隔的 Glob 模式，定義可選工作區 |
| `TELETOPAZ_CERT_FINGERPRINTS` | — | 逗號分隔的 SHA-256 指紋（TLS pinning） |
| `TELETOPAZ_SANDBOX` | — | 設為 `0`/`false`/`off` 以停用 macOS 沙盒（預設啟用） |

> 所有值透過 `npm run setup:secrets` 寫入 macOS Keychain，也可在 CI 直接設定環境變數。

## 執行

```bash
npm start
```

## Bot 頭像

Bot 頭像圖檔位於 `assets/TeleTopaz_icon.png`，請透過 @BotFather 的 `/setuserpic` 指令手動設定。

## 安全機制

- **沙盒 (macOS)**：啟動時透過 `sandbox-exec` 限制寫入權限至 `TELETOPAZ_DIRECTORY_PATTERNS` 展開的共同父目錄、macOS 暫存路徑及 Copilot 設定目錄。路徑依據使用者帳號自動偵測，無需手動設定。
- **人機協作確認**：AI 工具執行寫入或刪除操作前，會透過 Telegram 按鈕要求使用者即時確認。
- **Guardrails**：內建 Prompt Injection 偵測、敏感資訊過濾及語意分析護欄。

## 指令

| 指令 | 說明 |
|---|---|
| `/start`、`/help` | 顯示指令列表 |
| `/project` | 選擇工作區 |
| `/provider` | 切換 AI 供應商（Copilot / Gemini） |
| `/model [編號]` | 列出或切換 AI 模型 |
| `/info`（`/i`） | 檢視狀態 |
| `/new` | 重啟對話 |
| `/imgclear` | 清除附件圖片 |
| `/bye` | 關閉機器人 |

## 供應商支援

| 供應商 | 套件 | 驗證方式 | Tool Hooks |
|---|---|---|---|
| Copilot (預設) | `@github/copilot-sdk` | Device Auth | ✅ 完整支援 |
| Gemini | `@google/gemini-cli-core` | ADC (Application Default Credentials) | ✅ 透過 A2C 協議 |

### Gemini CLI 設定

1. 安裝 Gemini CLI Core：`npm install @google/gemini-cli-core`
2. 設定 ADC：`gcloud auth application-default login`
3. 在 Telegram 中使用 `/provider` 切換至 Gemini

## Acknowledgements

This project was inspired by doggy8088's MIT-licensed "telegram-copilot-bot" course material.
This codebase is a clean-room reimplementation and does not reuse original source code.
