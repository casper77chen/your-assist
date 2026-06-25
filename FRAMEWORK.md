# Your Assist — 把「77」變成可複製的助理框架

這份是 `Casper_Assist`（Casper 私人 LINE 助理）的**框架化分支**。
目標：讓任何人 fork 一份、填自己的設定，就有一個屬於自己的 LINE AI 助理。

> 分發模式：**先範本自架（fork-per-person），但 adapter／設定層刻意預留未來升級多租戶的空間。**
> 不動原 `Casper_Assist`（那是 Casper 的現役部署）。所有改造在本專案進行。

---

## 設計原則

1. **能力即外掛（capability = pluggable adapter）**
   每個模組（calendar / contacts / memory / wiki / todos…）是一個能力。
   啟用與否只看它的 `xxxConfigured`（=該模組需要的環境變數有沒有填）。
   - 工具清單（`TOOLS`）與 system prompt 都**依啟用的能力動態組裝**。
   - 一份只填了 LINE + Anthropic 的全新部署 → 自動退化成「純聊天（＋有 Google 就加行事曆）」，缺模組不會壞。

2. **身分／品牌即設定（profile）**
   助理名字、主人稱呼、口吻、專案簡稱、會議室/同事快捷……全部從程式碼抽進 `profile.js` + 環境變數。
   程式碼裡不再寫死「77」「Casper」「dentall」。

3. **人脈庫綁 Connectome（做成 contacts adapter 介面）**
   保留 Connectome，但上層只依賴抽象介面（findPerson / createPerson / logInteraction…），
   Connectome 是其中一個實作。未來要換別的 CRM 不動上層。

4. **知識庫＝可插拔 provider，二選一，預設關閉**（M7）
   `knowledge.js` 抽象層，provider 二選一：`mywiki`（capture+query）/ `obsidian`（capture，規劃中）/ none。
   工具名中性化為 `save_note` / `search_notes`。兩個 provider 的環境變數都沒設時：
   工具不註冊、system prompt 不提知識庫、記憶路由自動降路。provider 不支援查詢時 `search_notes` 也不註冊。

---

## 改造里程碑

- [x] **M0 — 複製專案**：從 `Casper_Assist` 複製一份（排除 node_modules / .env / 鎖檔）。
- [x] **M1 — 地基：profile + 去品牌化**
  - [x] `profile.js`：助理名/主人稱呼/口吻/簡稱，從 env 讀，含 `identityPromptSection()`。
  - [x] `shortcuts.js`：清空 Casper 私有會議室與同事，改成 env（`ROOMS_JSON`/`CONTACTS_JSON`）自填，空則不注入 prompt。
  - [x] 去品牌化 meta：`package.json` / `README.md` / `.env.example` / `CLAUDE.md`，移除 Casper 的 Zeabur ID、部署腳本（`部署77.command` 已刪）、私人簡稱。
  - [ ] `ARCHITECTURE.md` 還是 Casper 原版，留待順手更新（非阻塞）。
- [x] **M1.5 — 設定儲存層（為「網頁設定頁」與「動態 prompt」打底）**
  - [x] `settings.js`：覆寫存進記憶庫試算表 `settings` 分頁（key/value，自動建表）。同步快取 `loadSettings()`/`overrideOf()`，寫入即時刷新。沒接 Sheets 時 `settingsWritable=false`、設定頁唯讀。
  - [x] `profile.js` 改成三層動態讀：**覆寫(settings) → env → 預設**，全部 getter，網頁改完不必重啟。
  - [ ] index.js 啟動時呼叫 `loadSettings()`（待 M2/路由時一起接）。

- [x] **M2 — system prompt 拆成具名區塊 + `buildSystemPrompt()`**（最大塊；「可編輯行為規則」的基礎）
  - [x] `system-prompt.js`：`SYSTEM_PROMPT` 巨字串拆成 14 個具名區塊（核心人格 / 執行鐵則 / 各能力段落 / 記憶分流 / 多模態 / 輸出規則 / 快捷），預設寫死在 code。
  - [x] `buildSystemPrompt()` 每請求動態組：`overrideOf(key) ?? def()`，停用能力的區塊不注入；`listBlocks()` 給設定頁用。
  - [x] 記憶分流鐵則依啟用能力動態生成（<2 路就不放）。
  - [x] `assistant.js` 接上（刪舊 const、import buildSystemPrompt、請求迴圈改用）；`index.js` 開機 `loadSettings()`。
  - [x] `memoryPromptSection`（注入進 prompt）+ 圖片/PDF/語音訊息包裝 + 系統 nudge + 健康檢查頁 → 全去 Casper、改 `ownerName()`/`assistantName()`。
  - [x] 修掉 `??` 空字串不回退的 bug（最小部署無名）+ `.env.example` 的 `GOOGLE_OAUTH_CLIENT_ID` 名稱錯。
  - 驗證：`node --check` 全過；buildSystemPrompt 四情境煙霧測試（最小/改名/單能力/雙路由）通過。
  - ⏭ 留給 M3：`assistant.js` 的 **32 處 TOOLS 描述／工具回傳字串**仍寫死 Casper（TOOLS 是靜態 const，現在改會凍結；M3 把 TOOLS 變 builder 時用動態 `ownerName()` 一次處理）。
- [x] **M3 — `TOOLS` 依能力動態註冊 + 工具層去 Casper**
  - [x] `TOOL_CAPABILITY` 對照（23 工具→6 能力）+ `buildTools()`：每請求只暴露「已啟用能力」的工具；請求迴圈改 `tools: buildTools()`。`runTool` 各 handler 本就自帶 `Configured` 防呆（缺能力回友善訊息，不 crash）＝雙保險。
  - [x] `debrandTool()`：JSON round-trip 把工具物件（含巢狀 schema）裡的 `Casper` 哨兵字深層換成當下 `ownerName()`。**源碼 TOOLS 描述刻意保留 `Casper` 當預設主人哨兵，執行期才替換**（故名字能反映網頁即時改名、不凍結）。
  - [x] runTool 的 9 處回傳字串 Casper → `${ownerName()}`；`recordTranscript` 角色標籤 → `ownerName()`/`assistantName()`（已確認無程式靠字面值判斷）。
  - [x] `index.js` 收件人讀 `OWNER_LINE_USER_ID`（留 `CASPER_LINE_USER_ID` fallback）。
  - 驗證：A) 無能力 env → **純聊天零工具**；B) 只開 contacts → 剛好 10 工具、組出的 JSON 無 Casper 有主人名；C) 多能力 → 工具數正確隨能力增減。
  - ⏭ 留給後續：TOOLS 描述裡的 Casper 專屬「例子」（如 add_to_organization 的「AAMA/七期」）屬說明性、無害，日後可順手換成泛例；各 .js 的內部註解非 LLM/使用者可見，最後一次掃。
- [x] **M3.5 — `/settings` 網頁設定頁**
  - [x] `settings-page.js`：`renderSettingsPage()` + `applySettings()`（純函式、可測）。五區：①身分口吻 ②能力狀態 ③快捷 ④行為規則（14 個 prompt 區塊，details 可展開、勾「還原此區塊」、未啟用能力 disabled）⑤完整 prompt 預覽。每欄標「已覆寫 / 環境變數 / 預設」。
  - [x] 路由：`GET/POST /settings`（POST 掛獨立 `express.urlencoded` 不擾 webhook raw body；key 走 query 過 `requireSetupKey`）、`POST /settings/reset`（`resetAll()` 逃生門）。沒接 Sheets 時唯讀。
  - [x] `shortcuts.js` 改成動態讀 `rooms_json`/`contacts_json` 覆寫（網頁可即時編輯快捷）。
  - [x] 視覺套 **WCA Design System**（午夜藍×榮耀金、Noto Serif TC 標題、Playfair eyebrow、金箔 CTA、45° 細斜紋、無 emoji）。Hero 標語：**「從 77 助理，到你的助理」**。
  - 驗證：`node --check` 全過；渲染測試 22.8KB HTML，hero/WCA token/字體/eyebrow/能力狀態/預覽帶主人名皆正確、無 Casper、標籤開合平衡（2 form／5 section／14 details／17 textarea）。
  - ⏭ 留意：WCA DS folder 在專案內當參考；目前頁面樣式 hardcode WCA 風，日後若要讓「別人也能換自己品牌」可再抽主題層。`/help` 仍是舊 Casper 風公開頁，待 M5 順手去品牌。
- [x] **M4 — contacts adapter 介面**
  - [x] `contacts.js`：人脈能力介面層，用 `PROVIDERS` 表選 provider（env `CONTACTS_PROVIDER`，預設 connectome）；導出穩定介面 `contactsConfigured` / `contactsProvider` + findPeople/createPerson/updatePerson/createInteraction/createEvent/upcomingFollowups/createRelationship/tagPerson/addPersonToOrganization/syncPeople/getPeople/getInteractions。
  - [x] 五個核心消費端（assistant / system-prompt / briefing / meetwatch / weekly）改依賴 `contacts.js`，`connectomeConfigured`→`contactsConfigured`，**不再直接 import connectome.js**。
  - [x] Connectome 專屬 admin 操作（dedupe / merge / ping，只在 index.js setup 路由）維持直接依賴 connectome.js——provider 專屬維運，本就不屬通用介面。
  - 驗證：`node --check` 全過；開 contacts → provider=Connectome、findPeople 為函式、10 工具、prompt 有人脈段；關 contacts → 0 工具、無人脈段。
  - ⏭ 未來換 CRM：新增一個 provider 模組實作那組函式、在 `PROVIDERS` 註冊即可，上層零改動。介面函式名目前沿用 Connectome 語意（createInteraction 等），日後可再抽成中性動詞。
- [x] **M4.5 — 連接器（Connector）框架**
  - [x] `connectors.js`：把每個可連結的外部系統做成一張「卡」（Connectome 人脈 / Google 行事曆+記憶+待辦 / MyWiki / OpenAI 語音）。以「要連的外部帳號」為粒度；`listConnectors()` 附即時連線狀態與「還缺哪些環境變數」。新增連接器只加一筆。
  - [x] 設定頁 ②「Connectors / 連接器」區：每張卡顯示已連/未連、開通什麼、缺哪些 env、連結到 setup 路由（Connectome→/setup/connectome 驗證、Google→/oauth/connect 授權）。
  - 驗證：渲染測試卡片狀態正確（連 Connectome、其餘列缺項）、連結帶 key、無 Casper。
  - ⏭ 待決：目前「連結」=設環境變數後驗證。要不要做「在網頁直接輸入憑證、存進 settings」的一鍵連結？牽涉把 secret 存進 Google Sheet 的安全取捨，下一步問。
- [x] **M5 — 主動推播去個人化 + /help 去品牌**
  - [x] 推播模組（briefing / weekly / meetwatch）本就各區塊 capability-gated、文案通用；收件人 M3 已改 `OWNER_LINE_USER_ID`。晨報問候改用 `ownerNickname()`（「早安，明哥！」）。
  - [x] `/help` 重寫：依「目前連上哪些能力」動態長出清單（沒接的不出現）、標題用 `assistantName()`、套 WCA 視覺、移除 con/MW/CC 等 Casper 專屬內容；底部導去 /settings。
  - [x] 使用者可見訊息的 `CASPER_LINE_USER_ID` → `OWNER_LINE_USER_ID`（第 63 行 fallback 程式碼保留讀舊名）。
  - 驗證：實際啟動 server（假 env）curl 通過——啟動用 assistantName、/help 無能力時只剩對話+多模態、/ 健康檢查、/settings 無 key→403 有 key→200。buildBriefing 問候帶暱稱。
  - ⏭ 內部註解與 import 別名（ask77 等）仍含 77/Casper，非使用者/LLM 可見，最後一次掃。
- [x] **M6 — onboarding 文件 + 部署指南**
  - [x] `ONBOARDING.md`：「從零部署你自己的助理」逐步（Step 1 拿 LINE+Anthropic 金鑰 → 2 部署+env → 3 接 webhook → 4 改名換口吻 → 5 連接器 Google/Connectome/其他 → 6 推播），含常見問題 + 環境變數總覽表。對齊實際 env 與 setup 路由。
  - [x] README 連到 ONBOARDING。

- [~] **M7 — 知識庫 provider 化 + Obsidian capture**（核心已完成；Obsidian provider 卡在同步後端未拍板）
  - [x] **provider 抽象** `knowledge.js`（複用 contacts adapter 模式）：`PROVIDERS = { mywiki（capture+query）, obsidian（capture；query 之後） }` + none。env `KNOWLEDGE_PROVIDER` 明指優先、否則自動挑第一個設好的（mywiki 優先）。導出 `knowledgeProvider` / `knowledgeConfigured` / `knowledgeCanSearch` / `knowledgeLabel` / `saveNote` / `searchNotes`。上層只依賴此介面。
  - [x] **二選一**：偵測哪個 provider 的環境變數有填就用哪個；都填時 `KNOWLEDGE_PROVIDER` 決勝；指定但沒設好則自動降級到另一個或 none。設定頁 MyWiki 與 Obsidian 各一張卡（Obsidian 標「規劃中」）。
  - [x] **工具改名**：`log_decision` → `save_note`、`ask_wiki` → `search_notes`（assistant.js TOOL_CAPABILITY `knowledge`、runTool、buildTools；system-prompt.js `cap_knowledge` 區塊 + 路由 + 多模態；index.js /help）。provider 不支援查詢時 `buildTools` 不暴露 `search_notes`、prompt 那段改說「只能存、不能查」。煙霧測試：none=0 工具、mywiki=save+search、obsidian 強制但未設→降回 none。
  - [ ] **Obsidian provider = 同步後端 + capture**（`obsidian.js` 目前是骨架，`obsidianConfigured=false`）：因碰不到本機 Obsidian，須透過 vault 同步的雲端讀寫 `.md`。後端選項：Google Drive（傾向，複用既有 OAuth + 加 Drive scope）/ GitHub（Obsidian Git）/ Dropbox。**2026-06-25 Casper 決定：先不做 Obsidian**，保留骨架，等真有人要用再回來補（屆時定後端 → obsidian.js 補 saveToObsidian + obsidianConfigured + 連接器 requires env）。抽象層已預留，補上 provider 不動上層。
  - [ ] **capture 細節待定**：一則一檔 vs append 進當日 daily note、放哪個資料夾（如 `Inbox/`）、要不要 frontmatter（date/source:LINE/tags）、檔名規則。
  - **分段**：v1 只做 capture（最通用：LINE → markdown 進 vault）；v2 才做 query。MyWiki 的抽實體/衝突偵測維持 MyWiki 專屬，不移植。

---

## 進度註記
（每完成一步在這裡記一行，方便跨 session 接續。）
- 2026-06-24：M0、M1 完成。決定設定頁可編輯「全部含行為規則」→ 安全做法＝prompt 拆具名區塊、預設留 code、可還原。
- 2026-06-24：M1.5 完成 settings.js（覆寫存試算表 + 同步快取）+ profile.js 三層動態讀，node --check 通過。
- 2026-06-24：M2 完成。system-prompt.js（14 具名區塊 + buildSystemPrompt/listBlocks）、assistant.js/index.js 接線、memoryPromptSection 與訊息包裝去 Casper。四情境煙霧測試通過。已 npm install。
- 2026-06-24：M3 完成。buildTools() 依能力動態暴露工具 + debrandTool 深層去 Casper；runTool 回傳字串與 transcript 標籤參數化。三情境煙霧測試通過（無能力=0 工具、contacts=10、多能力遞增）。
- 2026-06-24：M3.5 完成。/settings 網頁設定頁（settings-page.js + 路由 + shortcuts 動態化），視覺套 WCA DS，hero「從 77 助理，到你的助理」。渲染測試通過。
- 2026-06-24：M4 完成。contacts.js adapter（provider 表，預設 Connectome），五個核心消費端脫鉤、改依賴介面。開關測試通過。
- 2026-06-24：M4.5 完成。connectors.js 連接器框架 + 設定頁「Connectors」區（Connectome/Google/MyWiki/OpenAI 卡片，顯示已連/未連與缺項、連結 setup 路由）。
- 2026-06-24：M5 完成。/help 動態去品牌 + WCA 化、晨報暱稱問候、CASPER_LINE_USER_ID 訊息去個人化。實際啟動 server curl 測試通過。
- 2026-06-24：M6 完成。ONBOARDING.md 部署指南 + README 連結。**框架化主線 M0–M6 全部完成。** 後續選做：連接器一鍵輸入憑證（secret 存 sheet 取捨）、設定頁主題可換、內部註解最後掃。
- 2026-06-24：M7 核心完成。`knowledge.js` provider 抽象（mywiki/obsidian/none，二選一）、工具改名 save_note/search_notes、`cap_knowledge` 區塊、connectors 加 Obsidian 卡、.env.example/FEATURES/ONBOARDING 更新。`obsidian.js` 留骨架（obsidianConfigured=false），**Obsidian 實作待同步後端拍板**。三情境煙霧測試通過。
- 2026-06-24：設定頁 hero 加「使用說明」CTA → 新 `/guide` 頁（renderGuidePage，6 步驟 onboarding 介紹頁，WCA 風，公開、帶 key 回設定頁）。curl round-trip 測試通過。
</content>
</invoke>
