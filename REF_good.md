# REF_telebot_project 相對 TeleTopaz 的分析與導入決策

## 結論摘要

`REF_telebot_project` 的真正亮點有三個：**持久化記憶**、**可觀測性較高的日誌輸出**，以及 **技能 / 工具知識可被工作階段直接利用**。  
但 TeleTopaz 目前在 **雙供應商抽象、自動路由、安全沙盒、人機確認、輸出遮罩、Prompt Guardrails、模組化程度** 上都明顯更完整。

因此，本次策略不是「照搬 REF」，而是只吸收它值得保留的部分，並改造成更符合 TeleTopaz 的安全版實作：

1. **採納：持久化會話記憶**
   - 導入為「**工作區作用域、已遮罩、寫入 app data 目錄**」的安全版本。
   - 避免 REF 直接把 `memory/`、`memory_archive/` 寫進使用者工作區的缺點。
2. **採納：日誌可觀測性補強**
   - 保留 TeleTopaz 原本的非阻塞寫檔與 redaction。
   - 補上 console 時間戳/等級、可配置 log 目錄、可 flush。
3. **採納：技能 / 工具知識的安全導入**
   - 讓 Copilot session 直接載入 TeleTopaz 內建與工作區自有的 `.github/skills`。
   - 不複製任何 skill 檔案到使用者專案，避免 workspace 汙染。
4. **不採納：REF 的工作區內記憶壓縮排程與單供應商耦合**
   - 這些設計對 TeleTopaz 會增加 repo 污染、回歸風險與安全面。

## 詳細對照

| 面向 | REF 的優點 | REF 的缺點 | TeleTopaz 原狀 | 決策 |
|---|---|---|---|---|
| 架構 | 記憶模組獨立、測試覆蓋不差 | 整體仍偏單體、與單供應商路徑耦合 | Provider / session / guardrails / sandbox 分層清楚 | 保留 TeleTopaz 架構，不回退 |
| 記憶系統 | 有持久化、多層摘要、實體索引概念 | 直接寫進工作區，容易污染專案與被誤提交 | 僅有執行期 session，缺少跨重啟延續 | **採納核心價值，但改成 app data + redaction 版** |
| 日誌 | console 有時間戳，輸出較容易追查 | 同步寫檔、忽略寫檔錯誤，較不利穩定性 | 已有 redaction 與非阻塞寫檔，但 console 可觀測性較弱 | **採納可觀測性，保留 TeleTopaz 非阻塞寫檔** |
| 技能 / 工具知識 | 會把 `additional_skills/` 與技能目錄概念帶進工作階段，讓代理更理解本地工具與流程 | 透過複製檔案到工作區實現，容易覆寫使用者檔案、污染 repo；若直接把工具文件內嵌成高信任 prompt，也有 indirect prompt injection 風險 | 會讀 AGENTS / MEMORY，但原本沒有真的把 skillDirectories 傳進 Copilot session | **採納能力本身，但改成「直接載入內建 / 工作區 skillDirectories」的無污染版本** |
| Guardrails | deny/allow 規則結構清楚 | 防護深度較淺，沒有 TeleTopaz 現有整合強度 | 內建 prompt injection、敏感資訊與工具輸出防護 | 不回退；維持 TeleTopaz 版本 |
| 安全 | 有基本遮罩意識 | 無沙盒、無工作區寫入最小權限、無 Telegram 工具確認 | 有 sandbox、人機確認、輸出遮罩、目錄白名單 | 完全保留 TeleTopaz 優勢 |
| 測試 | REF 在記憶/日誌上有明確單元測試 | 整體邊界條件仍偏窄 | TeleTopaz 已有 guardrails、sandbox、prompt 等測試 | 延續 TeleTopaz 測試風格並補足新功能 |

## 本次已採納並落地的 REF 優勢

### 1. 安全版持久化會話記憶

已導入 `src/session/memory-store.ts`，但設計上刻意**不複製** REF 的工作區內 `memory/` 目錄策略，而是改成：

- 預設寫入 `~/.teletopaz/session-memory`
- 可透過 `TELETOPAZ_DATA_DIR` 覆寫
- 以 **chatId + workDir hash** 做工作區隔離
- 寫入前一律經過 `redactStrict`
- 每筆內容會壓平空白、截斷長度、限制保留筆數
- 建立 session 時會把最近的已遮罩脈絡附加到 system prompt

這樣保留了 REF「跨重啟延續脈絡」的優點，同時避免：

- 在使用者 repo 產生可提交檔案
- 把敏感資料直接落地
- 對現有工作區流程造成干擾

### 2. 日誌可觀測性補強

TeleTopaz 原本 logger 已比 REF 更安全，因為它有：

- 非阻塞 Promise queue
- 檔案寫入前 redaction
- 分級輸出

本次再補上 REF 值得借鏡的部分：

- console log 加上本地時區 ISO timestamp 與 level
- 新增 `setLogDir()` 與 `TELETOPAZ_LOG_DIR`
- 新增 `flush()`，可在結束流程前把佇列寫完

也就是說，**採納了 REF 的「易追查」優點，但沒有帶入它的同步阻塞與靜默吞錯風險**。

### 3. 技能 / 工具知識安全導入

REF 的另一個可取處，是它有意識地把技能帶進 session，讓代理不是只靠模型預訓練，而是能參照本地 skill 規範。  
但 REF 的做法是把 `additional_skills/` 直接複製進使用者工作區，這對 TeleTopaz 而言風險太高。

本輪 TeleTopaz 改成更安全的等價作法：

- Copilot session 會直接載入 **TeleTopaz 內建 `.github/skills`**
- 若使用者工作區本身有 `.github/skills`，也會一併載入
- 若工作區的 `.github/skills` 透過 symlink 指向工作區外，會直接拒絕載入
- Auto-routing 的 classifier session 會固定使用安全工作目錄，並以 **read-only plan mode + deny-all tool hook** 避免工具繞行
- 全程**不複製任何 skill 文件進使用者 repo**

這樣保留了 REF「讓工作階段理解本地技能與工具約束」的優點，同時避免：

- 覆寫使用者現有 `.github/` 內容
- 把機器人附帶檔案寫入使用者版本庫
- 因複製流程造成不必要寫入權限與 side effect
- 透過工作區工具文件進行 indirect prompt injection

### 4. 沙盒權限同步補強

因為新增了 app data 型持久化記憶，本次同步補上 sandbox 白名單：

- 允許寫入 `~/.teletopaz`（或 `TELETOPAZ_DATA_DIR` 指定位置）

這是必要的最小調整，避免功能導入後繞過既有安全模型。

## 明確不導入的 REF 設計

### 不導入 1：直接在工作區生成 `memory/`、`memory_archive/`

原因：

- 容易污染使用者專案
- 容易被誤提交到 git
- 對多工作區、多專案切換較不乾淨
- 與 TeleTopaz 現有「工具在受控工作區操作、機器人自身狀態獨立保存」方向不一致

### 不導入 2：完整搬入每日壓縮排程

REF 的每日壓縮排程概念不差，但目前不是最小改動路線。  
本輪先導入「安全持久化 + recent context 注入」，等實際使用量證明需要，再決定是否增加摘要壓縮層。

### 不導入 3：降低 TeleTopaz 既有安全門檻

本專案既有優勢必須保留：

- 雙供應商（Copilot / Gemini）
- Auto routing
- macOS sandbox
- 人機確認高風險工具
- guardrails + redaction

REF 在這些面向沒有超越 TeleTopaz，因此不應反向退化。

### 不導入 4：把 `additional_skills/` 複製進使用者工作區，或把 `TOOLS.md` 直接內嵌成高信任 prompt

REF 的 `copyAdditionalSkills()` 對單一、可控的個人工作流有便利性，但在 TeleTopaz 中不適合作為預設：

- 會修改使用者工作區檔案
- 可能覆寫既有 `.github/` 內容
- 需要額外寫入權限，與最小權限方向相衝
- 會讓「啟動 session」變成具有副作用的操作
- 若把 `TOOLS.md` 原文直接併進 system prompt，還會帶入 indirect prompt injection 風險

因此本專案只採納「讓 session 能安全讀到 skills」這個能力，不採納「複製檔案進 repo」或「把工作區工具文件直接升格為高信任指令」這種做法。

## 本次修改後的實際收益

1. **服務重啟後仍能保留最近脈絡**
2. **不同工作區的記憶彼此隔離**
3. **持久化資料先遮罩再寫入，降低敏感資訊風險**
4. **日誌更容易追查，但仍保有非阻塞寫檔**
5. **Copilot session 能直接利用內建 / 工作區技能，而且會拒絕工作區外部的 symlink skills**
6. **Auto-routing 分類流程不會繞過既有工具安全邊界**
7. **工作區白名單改用 canonical realpath，比對與展開都能阻擋 symlink escape**
8. **sandbox 仍維持最小權限模型**

## 測試與驗證

本次新增/調整測試重點：

- `tests/session-memory.test.ts`
  - 驗證工作區隔離
  - 驗證 redaction 後才持久化
  - 驗證 recent context 組裝
- `tests/bot-memory.test.ts`
  - 驗證建立 session 時會帶入持久化記憶
  - 驗證一輪對話完成後會落地記憶
- `tests/logger.test.ts`
  - 驗證 console timestamp/level
  - 驗證自訂 log 目錄與 flush
- `tests/persona.test.ts`
  - 驗證工作區 `TOOLS.md` 不會被直接內嵌進 system prompt
- `tests/bot-memory.test.ts`
  - 驗證 Copilot session 會帶入內建與工作區 skillDirectories
  - 驗證 symlink 到工作區外部的 skills 會被拒絕
- `tests/bot-classifier.test.ts`
  - 驗證 classifier session 會使用安全工作目錄
  - 驗證 classifier session 會以 read-only plan mode 啟動
  - 驗證 classifier session 會 deny 所有工具呼叫
- `tests/gemini-sdk.test.ts`
  - 驗證 Gemini CLI 會把指定 approval mode 傳入實際命令列
  - 驗證所有 `tool_use` 都會先經過 `onPreToolUse`
- `tests/directories.test.ts`
  - 驗證白名單展開會拒絕指向工作區外的 symlink
  - 驗證 allowed directory 比對採 canonical real path
- `tests/sandbox-profile.test.ts`
  - 驗證 app data 路徑被正確放入 sandbox 白名單

## 最終評語

REF_telebot_project **不是整體上比 TeleTopaz 更好**，而是它在「記憶持久化」、「操作可觀測性」以及「技能 / 工具知識導入」三個局部設計上有可借鏡之處。  
本次修改採用的是 **TeleTopaz 主導、REF 擷取優點** 的策略：只導入高價值、低入侵、可安全落地的部分，避免把 REF 的工作區污染、同步 I/O、檔案複製副作用、單供應商耦合與安全邊界較弱等問題一起帶進來。
