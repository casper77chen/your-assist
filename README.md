# Your Assist 🤖

**可自架的個人 LINE AI 助理框架。** Fork 一份、填你自己的設定，就有一個住在 LINE 裡、屬於你的 AI 助理：管行事曆、人脈、長期記憶、待辦，並能主動推播晨報／週回顧。

> 這是 `Casper_Assist`（一個實際在跑的私人助理）的框架化版本。設計理念與改造進度見 [FRAMEWORK.md](./FRAMEWORK.md)。
>
> **要部署你自己的一台？** 跟著 [ONBOARDING.md](./ONBOARDING.md) 從零走一遍（先最小跑起來，再逐步連能力）。

## 能力是可插拔的

每個能力只在「對應環境變數有填」時才會啟用——你只想要聊天 + 行事曆也可以，不用全開：

| 能力 | 啟用條件（環境變數） |
|---|---|
| 對話（核心） | `LINE_*` + `ANTHROPIC_API_KEY` |
| Google 行事曆 / 會議室 | `GOOGLE_*` |
| 人脈管理（Connectome） | `CONNECTOME_*` |
| 長期記憶 / 待辦（Google Sheets） | `MEMORY_SPREADSHEET_ID` |
| 知識庫（MyWiki，預設關閉） | `MYWIKI_*` |
| 語音轉文字 | `OPENAI_API_KEY` |

## 本機測試
```bash
npm install
cp .env.example .env   # 至少填 LINE 兩個值 + ANTHROPIC_API_KEY + ASSISTANT_NAME / OWNER_NAME
npm run dev
```

## 部署
1. 把專案部署上你的平台（Zeabur / Railway / 自己的機器皆可）。
2. 設環境變數（見 `.env.example`）。
3. 拿到對外網域後，回 LINE 官方帳號後台 → Messaging API → **Webhook 網址**填 `https://你的網域/webhook` → 開啟「使用 Webhook」。
4. 關閉官方帳號的「自動回應訊息」（不然會搶著回）。

## 把它變成「你的」助理
最少只要設兩個變數就會改名換口吻：
- `ASSISTANT_NAME` — 助理叫什麼
- `OWNER_NAME` — 怎麼稱呼你

進階：`OWNER_NICKNAME`、`ASSISTANT_PERSONA`（口吻補充）、`OWNER_ABBREVIATIONS`、`ROOMS_JSON`、`CONTACTS_JSON`。詳見 `profile.js` 與 `shortcuts.js`。
