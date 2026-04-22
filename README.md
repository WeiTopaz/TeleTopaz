# 💎 TeleTopaz

以 TypeScript 實作的進階 AI 代理機器人，支援 **Telegram** 與 **WhatsApp** 雙頻道，整合 GitHub Copilot SDK、Google Gemini CLI 及 Claude Code CLI，具備智慧意圖路由（Auto-Routing）與安全沙盒機制。

## 特色

- **雙頻道**：同時運行 Telegram 與 WhatsApp，共用 AI 供應商設定。
- **多供應商**：整合 GitHub Copilot、Google Gemini 及 Claude Code，可依需求自由切換。
- **智慧路由 (Auto Mode)**：自動分析使用者意圖，簡單查詢使用輕量模型 (Router)，複雜任務切換至強力模型 (Core)。
- **安全持久化記憶**：以工作區為作用域保存最近對話脈絡，寫入前自動遮罩敏感資訊。
- **安全沙盒**：在 macOS 上透過 `sandbox-exec` 隔離執行環境，並嚴格限制檔案寫入權限。
- **人機協作護欄**：Telegram 上的敏感操作（寫入、刪除）需按鈕確認；WhatsApp 頻道因擁有者身份已透過手機掃碼驗證，自動核准。
- **隱私優先**：內建敏感資訊遮蔽 (Redaction) 與 Prompt Injection 防護。

## 需求

- Node.js 22+
- macOS（推薦，支援沙盒與 Keychain）或 Linux
- **Copilot**：需具備 GitHub Copilot 訂閱
- **Gemini**：需安裝並設定 `gemini` CLI（若要使用 Gemini 模型）
- **WhatsApp**（選用）：一個專用的 WhatsApp 帳號（實體 SIM 卡或虛擬號碼均可）

---

## 從零開始：Telegram 設定

### 步驟 1：建立 Telegram Bot

1. 在 Telegram 搜尋 **@BotFather**，發送 `/newbot`
2. 依指示輸入 Bot 名稱與帳號（帳號必須以 `bot` 結尾）
3. 取得 **Bot Token**（格式如 `7123456789:AAF...`），妥善保存

### 步驟 2：取得擁有者 Chat ID 與 User ID

```bash
# 方法一：訪問以下 URL（替換 <BOT_TOKEN>）
# 先對你的 Bot 發送任意訊息，再開啟：
# https://api.telegram.org/bot<BOT_TOKEN>/getUpdates
#
# 回應中 "chat":{"id":...} 為 OWNER_CHAT_ID
#        "from":{"id":...} 為 OWNER_USER_ID

# 方法二：搜尋 @userinfobot，發送 /start 即可取得 User ID
```

### 步驟 3：安裝依賴並設定 Secrets

```bash
npm install
npm run setup:secrets
```

互動式提示會依序詢問：

```
bot_token (required): 7123456789:AAF...
owner_chat_id (required): 123456789
owner_user_id (required): 123456789
directory_patterns (optional): ~/Projects/*, ~/Documents/TempNote
wa_owner_jids (optional):                     ← 留空跳過（WhatsApp 後續可再設定）
```

> `directory_patterns` 為逗號分隔的 Glob 路徑，定義 AI 可操作的工作區根目錄。

### 步驟 4：啟動

```bash
npm start
```

首次啟動 GitHub Copilot SDK 時，Log 會顯示裝置驗證連結，在瀏覽器開啟並授權即可。啟動後在 Telegram 對你的 Bot 發送任意訊息即可開始對話。

---

## 從零開始：WhatsApp 設定

WhatsApp 頻道採用 **Linked Device** 模式（同 WhatsApp Web），需要一個**專屬的 WhatsApp 帳號**作為 Bot 號碼（你的個人號碼用來與它對話）。

> **架構說明**：Bot 以 Linked Device 身份連結「Bot 號碼」的 WhatsApp；你用「個人號碼」傳訊給 Bot 號碼，Bot 確認發訊人是擁有者後處理請求。

### 步驟 1：準備一個專屬 WhatsApp 帳號

- 使用備用 SIM 卡、Google Voice、或其他虛擬號碼開通 WhatsApp
- 這個號碼即為「Bot 號碼」

### 步驟 2：設定擁有者 JID

擁有者 JID 為**你的個人手機號碼**（含國碼，無 `+` 號）。

**方法一：setup:secrets（推薦）**

```bash
npm run setup:secrets
# wa_owner_jids (optional): 886912345678
```

**方法二：macOS Keychain 直接寫入**

```bash
security add-generic-password -U \
  -s "teletopaz" -a "wa_owner_jids" \
  -w "886912345678"
```

**方法三：環境變數（`.env` 檔）**

```bash
echo 'TELETOPAZ_WA_OWNER_JIDS=886912345678' >> .env

# 多支手機（逗號分隔）
echo 'TELETOPAZ_WA_OWNER_JIDS=886912345678,1234567890' >> .env
```

> 號碼格式：含國碼、無 `+` 號、無 `@` 後綴。台灣範例：`886912345678`（0912-345-678 → 去掉開頭的 0，加上國碼 886）。

### 步驟 3：啟動並掃描 QR Code

```bash
npm start
```

啟動後終端機會顯示 QR Code：

```
📱 掃描 QR Code 連接 WhatsApp（連結裝置）:

[QR Code 圖形]
```

**掃描步驟（在 Bot 號碼的手機上操作）**：

1. 開啟 Bot 號碼手機的 **WhatsApp**
2. 點選右上角 **⋮ → 連結裝置（Linked Devices）**
3. 點選「**連結裝置（Link a Device）**」
4. 對準終端機掃描 QR Code

掃描成功後 Log 會顯示：`✅ Connected to WhatsApp`

### 步驟 4：從個人手機開始對話

1. 用你的**個人手機**（即 `TELETOPAZ_WA_OWNER_JIDS` 設定的號碼）開啟 WhatsApp
2. 新增聯絡人：輸入 **Bot 號碼**（含國碼，如 `+886 9xx xxx xxx`）
3. 傳送任意訊息（如 `hello`）
4. Bot 回覆 `⏳處理中…`，稍後返回 AI 回應

### WhatsApp 可用指令

| 指令 | 說明 |
|---|---|
| `/info` | 顯示目前工作區、模型與連線狀態 |
| `/project` | 列出可用工作區 |
| `/project <編號>` | 切換工作區 |
| `/model` | 顯示目前模型 |
| `/model <entry>` | 切換模型（如 `/model cccli:claude-sonnet-4.6`） |
| `/clear` | 清除對話並重置工作階段 |

---

## 環境變數

| 變數 | 必要 | 說明 |
|---|---|---|
| `TELETOPAZ_BOT_TOKEN` | ✅ | Telegram Bot Token |
| `TELETOPAZ_OWNER_CHAT_ID` | ✅ | Telegram 擁有者的 Chat ID |
| `TELETOPAZ_OWNER_USER_ID` | ✅ | Telegram 擁有者的 User ID |
| `TELETOPAZ_DIRECTORY_PATTERNS` | ✅ | 逗號分隔的 Glob 模式，定義可選工作區與沙盒可寫入根目錄 |
| `TELETOPAZ_DATA_DIR` | — | App data 目錄（預設 `~/.teletopaz`） |
| `TELETOPAZ_LOG_LEVEL` | — | `debug` / `info` / `warn` / `error` |
| `TELETOPAZ_LOG_DIR` | — | 日誌輸出目錄（預設 `./logs/`） |
| `TELETOPAZ_WA_OWNER_JIDS` | — | WhatsApp 擁有者電話，逗號分隔（含國碼，無 `+`）；不設定則 WhatsApp 頻道不啟動 |
| `TELETOPAZ_WA_AUTH_DIR` | — | WhatsApp 認證資料目錄（預設 `~/.teletopaz/whatsapp-auth`） |
| `TELETOPAZ_WA_MODEL` | — | WhatsApp 頻道預設模型（格式同 `TELETOPAZ_DEFAULT_MODEL`，如 `ctcli:gpt-5.4`） |

> 所有欄位皆可由環境變數覆蓋。`npm run setup:secrets` 會將 Bot Token / Owner IDs / WA Owner JIDs 寫入 macOS Keychain。

---

## Telegram 指令列表

| 指令 | 說明 |
|---|---|
| `/help` | 顯示說明與指令列表 |
| `/project` | 選擇工作目錄（Workspace） |
| `/newproject <名稱>` | 在目前工作區旁建立新專案目錄 |
| `/model` | 設定 AI 模型與路由模式（Auto/Manual） |
| `/teletopaz` | 切換到 `TeleTopaz` 專案並使用 `cdcli:gpt-5.4` |
| `/diary` | 切換到 `MyDiary` 專案並使用 `cdcli:gpt-5.4-mini` |
| `/notebook` | 切換到 `MyNotebook` 專案並使用 `cccli:claude-sonnet-4.6` |
| `/info`（或 `/i`） | 檢視目前狀態、模型與資源使用量 |
| `/clear` | 清除對話歷史與附件圖片，並重啟工作階段 |
| `/router {prompt}` | 以 Router 模型執行單次對話，完成後自動還原 |
| `/allowall` | 切換全部允許 / 操作確認模式 |
| `/silent` | 切換安靜模式 |
| `/restart` | 熱啟動服務 |
| `/quit` | 安全關閉機器人 |

---

## Telegram 快捷按鈕

| 按鈕 | 目標專案 | 模型 |
|---|---|---|
| `TeleTopaz` | `TeleTopaz` | `cdcli:gpt-5.4` |
| `📔 日記` | `MyDiary` | `cdcli:gpt-5.4-mini` |
| `📓 筆記` | `MyNotebook` | `cccli:claude-sonnet-4.6` |

上述三顆按鈕與 `/teletopaz`、`/diary`、`/notebook` 共用同一份快捷設定，行為一致。

---

## 目前內建模型

| Entry | 供應商 | 說明 |
|---|---|---|
| `ctcli:gpt-5.4` | GitHub Copilot | **預設 Core** |
| `ctcli:gpt-5-mini` | GitHub Copilot | 輕量，適合 Router |
| `ctcli:claude-opus-4.6` | GitHub Copilot | |
| `ctcli:claude-sonnet-4.6` | GitHub Copilot | |
| `gmcli:gemini-3.1-pro-preview` | Google Gemini | |
| `cccli:claude-opus-4.7` | Claude Code CLI | |
| `cccli:claude-sonnet-4.6` | Claude Code CLI | |
| `cccli:claude-haiku-4.5` | Claude Code CLI | 輕量 |

> Auto Mode 預設以 `cdcli:gpt-5.4-mini` 作為 Router、`cdcli:gpt-5.4` 作為 Core。

---

## AI 供應商設定

### 1. GitHub Copilot（預設）

使用 `@github/copilot-sdk`。首次啟動時依 Log 指示進行裝置驗證（Device Auth）。

### 2. Google Gemini（選用）

```bash
npm install -g @google/gemini-cli-core
gcloud auth application-default login
```

在 Bot 中使用 `/model gmcli:gemini-3.1-pro-preview` 切換。Gemini 工作階段以 **read-only plan mode** 執行（不執行寫入或 shell 操作）。

### 3. Claude Code CLI（預設核心模型）

需安裝 [Claude Code](https://claude.ai/code) 並完成登入：

```bash
claude --version   # 確認已安裝
```

---

## 安全機制

- **沙盒（macOS）**：`npm start` 強制以沙盒啟動；可寫入範圍僅限於 `TELETOPAZ_DIRECTORY_PATTERNS` 根目錄、系統暫存區與 app data 目錄。
- **讀取限制**：讀取型工具只允許存取目前選定工作區；`.env`、`.ssh`、`.aws`、`id_*` 等敏感路徑直接拒絕。
- **操作確認（Telegram）**：`write`、`delete`、`edit` 等高風險工具操作會發送按鈕要求確認。
- **自動核准（WhatsApp）**：WhatsApp 頻道的工具操作自動核准（擁有者身份已透過手機掃碼驗證）。
- **Guardrails**：拒絕未授權目錄存取，過濾 API Keys / 私鑰，偵測 Prompt Injection。
- **持久化記憶**：對話脈絡先經 `redactStrict` 遮罩後，再寫入 app data，不寫回工作區。

---

## 專案結構

```
src/
├── bot.ts                  # Telegram 機器人核心邏輯
├── index.ts                # 進入點（同時啟動 Telegram + WhatsApp）
├── whatsapp/
│   ├── client.ts           # Baileys WhatsApp 客戶端封裝
│   └── service.ts          # WhatsApp 頻道服務
├── session/                # 對話狀態、Prompt 組裝與 Persona 管理
├── copilot/                # GitHub Copilot SDK 整合
├── gemini/                 # Google Gemini CLI 封裝
├── claude/                 # Claude Code CLI 封裝
├── config/                 # Secrets、模型、目錄設定
└── guardrails/             # 安全護欄規則與評估
```

---

## Acknowledgements

This project was inspired by doggy8088's MIT-licensed "telegram-copilot-bot" course material.
This codebase is a clean-room reimplementation and does not reuse original source code.

WhatsApp integration adapted from [HKUDS/nanobot](https://github.com/HKUDS/nanobot) (MIT License).
