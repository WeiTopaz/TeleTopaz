# REF_telebot_project 相對 TeleTopaz 的分析與導入決策

## 結論摘要

`REF_telebot_project` 並不是整體上比 TeleTopaz 更好；它的強項集中在 **模型清單正規化**、**暫時性網路錯誤的可觀測性**、**持久化記憶**、以及 **技能知識導入**。  
TeleTopaz 仍然在 **雙供應商抽象、自動路由、macOS sandbox、人機確認、敏感資訊遮罩、Prompt Guardrails、測試覆蓋** 上明顯更完整。

因此，本次不是「把 REF 全搬進來」，而是採取 **TeleTopaz 主導、REF 擷取優點** 的策略：

1. **採納 REF 的模型清單與 `provider:model` 概念**，但把 CLI 標籤縮寫為 `ctcli` / `gmcli`，同時保留 TeleTopaz 內部 `copilot` / `gemini` 抽象，避免大範圍重構。
2. **採納 REF 對 transient network error 的可觀測性優點**，補上 Telegram polling 的網路錯誤摘要與重複日誌抑制，提升穩定性追查能力。
3. **保留先前已證明有效的安全版導入**：app-data 型持久化記憶、非阻塞 logger、skills 直接載入但不污染工作區。
4. **不導入 REF 的副作用設計**：工作區內 `memory/`、`memory_archive/`、複製 `additional_skills/`、同步 I/O、單供應商耦合。

---

## 詳細對照：優點、缺點與導入決策

| 面向 | REF 的優點 | REF 的缺點 | TeleTopaz 現況 | 本次決策 |
|---|---|---|---|---|
| 模型管理 | 以單一 `provider:model` 字串維護模型，切換與顯示一致 | provider 命名綁死 `copilotCLI` / `geminiCLI`，不利 TeleTopaz 內部抽象延續 | 先前可用模型與 UI 顯示分散，provider 顯示為 `copilot` / `gemini` | **採納**：改為 REF 式 entry 管理，但 UI 顯示用 `ctcli` / `gmcli`，內部 provider 照舊 |
| 服務穩定性 | 會抽取 transient network error 摘要，並抑制短時間重複 polling 日誌 | 整體仍偏單供應商流程，無法直接沿用到 TeleTopaz 全系統 | TeleTopaz 本來會重試 polling，但錯誤摘要較粗、重複 warn 噪音較大 | **採納**：補入 network summary + repeated log dedupe，保留既有輪詢重試流程 |
| 處理邏輯 | Event queue 與 prompt queue 邏輯直接、容易追 | 佇列容量較小，且工作區副作用較多 | TeleTopaz 既有 event queue、assistant message 去重、PENDING_LIMIT=15，處理流較完整 | 保留 TeleTopaz 流程，不回退 |
| 持久化記憶 | 有跨重啟脈絡延續能力 | 直接寫進使用者工作區，容易污染 repo、被誤提交 | TeleTopaz 已改為 app data + redaction + workspace scope | 保留 TeleTopaz 安全版，不回退 |
| 日誌與可觀測性 | console timestamp 與 level 明確，網路錯誤較容易追 | 同步寫檔與靜默吞錯風險較高 | TeleTopaz 已具非阻塞寫檔、redaction、flush | 保留 TeleTopaz logger，僅吸收 REF 可觀測性優點 |
| 技能 / 工具知識 | 會將本地技能帶入 session，降低純靠預訓練的風險 | 透過複製檔案到工作區實現，會污染使用者 repo | TeleTopaz 已直接載入 bundled/workspace skillDirectories，並拒絕越界 symlink | 保留 TeleTopaz 安全作法 |
| 安全 | 有基本敏感資訊意識 | 無 sandbox、無工具確認、無最小權限工作區寫入模型 | TeleTopaz 有 sandbox、human approval、guardrails、redaction | 完全保留 TeleTopaz 優勢 |
| 測試 | 模型與記憶模組具一定測試 | 整體覆蓋面仍窄於 TeleTopaz | TeleTopaz 既有 sandbox / memory / guardrails / provider tests | 延續 TeleTopaz 測試風格並補上新測試 |

---

## 針對服務穩定性與處理邏輯的重點分析

### REF 值得借鏡的地方

1. **模型 entry 正規化**
   - REF 以單一 `provider:model` entry 當作 UI 與設定來源，避免「模型名稱在一處、provider 在另一處」的顯示不一致。
   - 這對 TeleTopaz 的 `/model`、`/info`、連線提示、處理中訊息都很有價值。

2. **暫時性網路錯誤的摘要化與去重**
   - REF 會從巢狀錯誤中抽取 `ETIMEDOUT`、`ECONNRESET`、`ENOTFOUND` 等網路代碼，並在短時間內抑制重複 polling log。
   - 這不會改變核心邏輯，但會顯著降低 log 噪音，提升線上追查效率。

3. **本地技能知識導入**
   - 讓 session 知道專案內的技能與工具規範，比單靠模型預訓練更穩。
   - 這點 TeleTopaz 已用更安全的方式落地，因此不需改回 REF 的複製檔案版本。

### REF 不應帶入 TeleTopaz 的地方

1. **工作區副作用太重**
   - `memory/`、`memory_archive/`、`additional_skills/` 複製行為都會直接寫進使用者 repo。
   - 對 TeleTopaz 這種強調最小權限與受控工作區的設計來說，這是明確退步。

2. **安全邊界較弱**
   - REF 缺少 TeleTopaz 既有的 sandbox、工具確認、guardrails 與目錄白名單整合。
   - 若直接照搬，會破壞本專案「先安全、再能力」的基調。

3. **單供應商視角較重**
   - REF 的流程雖然清楚，但其實是圍繞單一 provider 路徑去寫。
   - TeleTopaz 需要維持 Copilot / Gemini 雙供應商與 Auto Mode，不適合退回單一路徑思維。

---

## 本次已導入的 REF 優勢

### 1. 模型清單改採 REF inventory，但用 TeleTopaz 風格安全落地

已將模型清單統一為：

- `ctcli:gpt-5.4`
- `ctcli:gpt-5-mini`
- `ctcli:claude-opus-4.6`
- `ctcli:claude-sonnet-4.6`
- `gmcli:gemini-3.1-pro-preview`

實作重點：

- `src/config/models.ts`
  - 以 entry 形式集中維護模型清單
  - 新增 `formatModelEntry()`、`parseModelEntry()`、`normalizeModelEntry()`
  - `TELETOPAZ_DEFAULT_MODEL` 同時接受 raw model name 與 `provider:model`
- `src/bot.ts`
  - `/model`、`/info`、歡迎訊息、連線訊息、處理中提示、輸出 header 都統一顯示 `ctcli:model` / `gmcli:model`
  - Auto Mode 會同時正確顯示 Router/Core 兩側的 provider label，而不再誤用 `state.provider`

這保留了 REF「單一顯示來源」的優點，同時避免把內部 provider 型別也一起改壞。

### 2. Telegram polling 的 transient network error 摘要與去重

本次在 `src/util/errors.ts` 與 `src/bot.ts` 補上：

- 巢狀錯誤中的網路代碼抽取
- `api.telegram.org:443` 等目標摘要顯示
- 短時間相同 transient error 的重複 log 抑制

效益：

- 服務遇到短暫網路抖動時，仍維持原本 retry 行為
- log 不再因連續相同 timeout 被洗版
- 真正需要追查時，能更快看到具體錯誤代碼與目標位址

這是 REF 在穩定性觀察面最值得帶回來、且對 TeleTopaz 最低風險的一個優點。

### 3. 既有安全版導入維持不退步

TeleTopaz 目前已保留且持續受益於下列 REF 衍生優勢，但都以更安全方式落地：

- `src/session/memory-store.ts`
  - app data + redaction + workspace scope 的持久化記憶
- `src/util/logger.ts`
  - timestamp / level / flush / configurable log dir，但保留非阻塞寫檔
- `src/bot.ts` + `.github/skills`
  - 直接載入 skills，不複製檔案進使用者工作區

---

## 明確不導入的 REF 設計

### 不導入 1：工作區內 `memory/`、`memory_archive/`

原因：

- 容易污染使用者專案
- 容易被誤提交到 git
- 與 TeleTopaz 既有最小權限與 app-data 狀態分離設計衝突

### 不導入 2：複製 `additional_skills/` 到工作區

原因：

- 會修改使用者 repo
- 可能覆寫現有 `.github/` 內容
- 讓「啟動 session」變成有副作用的操作
- 增加 indirect prompt injection 面積

### 不導入 3：同步寫檔與靜默吞錯

原因：

- REF 在 logger 層面較容易造成阻塞與可觀測性假象
- TeleTopaz 既有 Promise queue + flush + redaction 實作更適合長期服務穩定性

### 不導入 4：單供應商耦合流程

原因：

- 會破壞 TeleTopaz 的雙供應商與 Auto routing 優勢
- 無法符合本專案既有 provider abstraction

---

## 本次修改後的實際收益

1. **模型清單與 UI 顯示來源一致**
2. **`/model`、`/info`、工作階段連線提示都統一為 `provider:model`**
3. **CLI provider 標籤更精簡，改為 `ctcli` / `gmcli`**
4. **Auto Mode 的 Router/Core 顯示更正確，不再混用目前 session provider**
5. **Telegram polling 遇到 transient network issue 時更容易追查**
6. **重複 timeout / reset 日誌不再大量洗版**
7. **既有 sandbox、guardrails、人機確認與持久化記憶優勢完整保留**

---

## 測試與驗證

本輪新增或調整的重點測試：

- `tests/models.test.ts`
  - 驗證 REF 模型清單已同步到 TeleTopaz
  - 驗證 `ctcli` / `gmcli` 顯示格式
  - 驗證 `TELETOPAZ_DEFAULT_MODEL` 支援 `provider:model`
- `tests/bot-model-display.test.ts`
  - 驗證 `/info` 與模型選單顯示為 `ctcli:model` / `gmcli:model`
  - 驗證舊模型已不再出現在選單
- `tests/bot-polling.test.ts`
  - 驗證 transient polling error 會被去重
  - 驗證 log 會帶出網路摘要
- `tests/errors.test.ts`
  - 驗證 network summary 抽取與 repeated log 判斷
- `tests/bot-memory.test.ts`
  - 驗證 Gemini 端仍以新核心模型建立 session
- `tests/gemini-sdk.test.ts`
  - 將 Gemini 測試模型名同步到 `gemini-3.1-pro-preview`

驗證結果：

- `npm run build` ✅
- `npm run test` ✅

---

## 最終評語

REF_telebot_project 的價值，不在於它整體比 TeleTopaz 更成熟，而在於它有幾個**局部設計點非常實用**：

- 模型 entry 正規化
- transient network error 的摘要與去重
- 記憶與技能知識的導入意識

本次修改遵循的原則是：**只把 REF 真正能提升穩定性與操作一致性的部分帶進來，其他會削弱安全、造成工作區副作用、或破壞雙供應商架構的部分，一律不導入。**
