# 從零部署你自己的助理

這份帶你把 Your Assist 變成一個住在你 LINE 裡、屬於你的 AI 助理。
哲學：**先用最小設定跑起來（純聊天），確認管線通了，再一個一個連上能力。**

> 名詞：設計理念見 [FRAMEWORK.md](./FRAMEWORK.md)；能力＝可插拔，填了對應憑證才會開。

---

## 路線圖（先做 Step 1–4，其餘按需要再加）

| Step | 做什麼 | 結果 |
|---|---|---|
| 1 | 拿 LINE + Anthropic 金鑰 | 有最小必備憑證 |
| 2 | 部署 + 設環境變數 | 服務上線 |
| 3 | 接 LINE webhook | LINE 能跟它對話 |
| 4 | 改名換口吻（變成「你的」） | 純聊天助理完成 ✅ |
| 5+ | 連接器：Google / Connectome / 其他 | 逐步長出能力 |

---

## Step 1 — 拿兩把必備金鑰

1. **LINE Messaging API**
   - 到 [LINE Developers Console](https://developers.line.biz/) → 建一個 **Provider** → 建 **Messaging API channel**。
   - 拿 **Channel secret**（Basic settings）與 **Channel access token**（Messaging API 分頁，按發行）。
   - 把官方帳號的「自動回應訊息」**關掉**（不然會跟助理搶著回）。
2. **Anthropic API key**
   - [console.anthropic.com](https://console.anthropic.com/) → API Keys → 建一把。
   - （或用相容的 OpenAI-style endpoint，例如 Zeabur AI Hub。）

---

## Step 2 — 部署 + 設環境變數

本框架不綁平台，任何能跑 **Node ≥ 20** 的地方都行（Zeabur / Railway / Render / 自己的機器）。

**最小必填環境變數：**
```
LINE_CHANNEL_SECRET=...
LINE_CHANNEL_ACCESS_TOKEN=...
ANTHROPIC_API_KEY=...
ASSISTANT_NAME=小幫          # 你的助理叫什麼
OWNER_NAME=阿明              # 怎麼稱呼你
SETUP_KEY=自己設一串隨機字   # 保護 /settings 與一次性設定路由
```
完整清單見 [`.env.example`](./.env.example)。**任何 secret 都別進 git。**

本機先試：
```bash
npm install
cp .env.example .env   # 填上面那幾個
npm run dev
```
打開 `http://localhost:3000/` 看到 `小幫 is alive 🤖` 就對了。

部署到雲端後，記下你的對外網域（例如 `https://xxx.zeabur.app`）。

---

## Step 3 — 接上 LINE webhook

1. LINE 官方帳號後台 → Messaging API → **Webhook URL** 填 `https://你的網域/webhook` → 儲存。
2. 開啟「使用 Webhook」。
3. 用手機加官方帳號好友，傳一句話 → 助理會用你設的名字、口吻回你。

**驗收**：傳「哈囉」→ 它自然回覆 ✅。到這裡你已經有一個純聊天助理了。

---

## Step 4 — 把它變成「你的」

兩種方式（擇一或併用）：

- **環境變數**：`ASSISTANT_NAME` / `OWNER_NAME` / `OWNER_NICKNAME` / `ASSISTANT_PERSONA`（口吻補充）/ `OWNER_ABBREVIATIONS`（簡稱對照，如 `con=人脈庫`）。
- **網頁設定頁**（建議，可即時改不必重啟）：開 `https://你的網域/settings?key=你的SETUP_KEY`
  - ① 身分・口吻：改名字、稱呼、暱稱、口吻、簡稱。
  - ② 連接器：看目前連上哪些、還缺什麼（見 Step 5）。
  - ③ 快捷：會議室 / 同事代號。
  - ④ 行為規則：助理的每一段 system prompt 都能看 / 改 / 一鍵還原。
  - ⑤ 預覽：實際送進 AI 的完整 prompt。
  - > 設定頁要能「存」需先連上 Google（Step 5），沒連時是唯讀檢視。

---

> 想知道「哪個功能要連哪個連接器」的完整對照，見 [FEATURES.md](./FEATURES.md)。

## Step 5 — 連接器：逐步長出能力

到 `/settings` ② 區會看到每個可連結系統的卡片（已連 / 未連 / 缺哪些變數）。連上哪個，對應能力就開。

### 5a. Google（行事曆 + 記憶 + 待辦 + Coach）
連一個 Google 帳號，一次開通行事曆/會議室、長期記憶、待辦、Coach Inbox（資料都存你自己的 Google）。

1. [Google Cloud Console](https://console.cloud.google.com/) → 建專案 → 啟用 **Google Calendar API** 與 **Google Sheets API**。
2. 建 **OAuth 2.0 用戶端 ID**（類型：網頁應用程式），授權重新導向 URI 填 `https://你的網域/oauth/callback`。
3. 設環境變數 `GOOGLE_OAUTH_CLIENT_ID`、`GOOGLE_OAUTH_CLIENT_SECRET`，部署 / 重啟。
4. 瀏覽器開 `https://你的網域/oauth/connect?key=你的SETUP_KEY` → 授權 → 頁面給你一串 **refresh token**。
5. 把它設成 `GOOGLE_REFRESH_TOKEN`，重啟 → 行事曆能力開了。
6. 開 `https://你的網域/setup/memory?key=你的SETUP_KEY` → 自動幫你建一張記憶試算表，回傳一個 ID。
7. 把它設成 `MEMORY_SPREADSHEET_ID`，重啟 → 長期記憶 / 待辦 / Coach Inbox / 設定頁存檔 都開了。

> 會議室快捷：開 `/setup/rooms?key=SETUP_KEY` 可挖出你用過的會議室資源 email，填到 `/settings` ③ 區。

### 5b. Connectome（人脈管理）
用你自己的 Connectome 帳號當人脈庫——接起來就能用 LINE 找人、建檔、記互動、追跟進、管組織關係。

1. 設環境變數 `CONNECTOME_EMAIL`、`CONNECTOME_PASSWORD`（你的 Connectome 登入帳密；帳號需為 active）。
2. （選用）`CONNECTOME_BASE_URL`，預設 `https://connectome.com.tw`。
3. 重啟後開 `https://你的網域/setup/connectome?key=你的SETUP_KEY` 驗證連線 → 顯示你的聯絡人數就成功了。

### 5c. 其他連接器（選用）
- **MyWiki（決策日誌 / 知識庫）**：設 `MYWIKI_BASE_URL`、`MYWIKI_API_KEY`。
- **OpenAI（語音轉文字）**：設 `OPENAI_API_KEY`，LINE 語音訊息會自動轉文字。
- **iCal**：`ICAL_FEED_URL` 設 iCloud/Apple 公開 .ics 網址，晨報/週回顧會合併。

---

## Step 6 — 主動推播（晨報 / 週回顧，選用）

1. 先用 LINE 傳一句話給助理。
2. 開 `https://你的網域/brief?key=你的SETUP_KEY` → 會顯示你的 LINE userId。
3. 設成環境變數 `OWNER_LINE_USER_ID`，重啟。
4. 之後每天 `BRIEFING_TIME`（預設 07:00 台北）推晨報、`WEEKLY_TIME`（預設週日 21:00）推週回顧。`/brief`、`/weekly` 可立即補發。

---

## 常見問題

- **傳訊息沒反應**：確認 webhook URL 結尾是 `/webhook`、官方帳號「自動回應」已關、`LINE_*` 兩個值沒貼錯。
- **回覆說「行事曆/人脈還沒設定好」**：那個能力的環境變數沒填齊；到 `/settings` ② 區看缺哪些。
- **設定頁說唯讀、存不了**：還沒連 Google（缺 `MEMORY_SPREADSHEET_ID`）；完成 Step 5a 即可編輯。
- **OAuth 沒拿到 refresh token**：到 Google 帳號 → 安全性 → 第三方存取，移除本 app 後再跑一次 `/oauth/connect`。
- **改了名字沒生效**：用環境變數要重啟；用 `/settings` 改則即時生效。

---

## 一張表：環境變數總覽

| 變數 | 必填 | 開什麼 |
|---|---|---|
| `LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN` | ✅ | LINE 收發 |
| `ANTHROPIC_API_KEY` | ✅ | 大腦（Claude） |
| `ASSISTANT_NAME` / `OWNER_NAME` | 建議 | 助理名 / 主人稱呼 |
| `SETUP_KEY` | 建議 | 保護 /settings 與 setup 路由 |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` / `GOOGLE_REFRESH_TOKEN` | 選 | 行事曆 |
| `MEMORY_SPREADSHEET_ID` | 選 | 記憶 / 待辦 / Coach / 設定頁存檔 |
| `CONNECTOME_EMAIL` / `CONNECTOME_PASSWORD` | 選 | 人脈管理 |
| `MYWIKI_BASE_URL` / `MYWIKI_API_KEY` | 選 | 決策日誌 / 知識庫 |
| `OPENAI_API_KEY` | 選 | 語音轉文字 |
| `OWNER_LINE_USER_ID` | 選 | 主動推播收件人 |
| `ICAL_FEED_URL` / `BRIEFING_TIME` / `WEEKLY_TIME` | 選 | iCal 合併 / 推播時間 |
