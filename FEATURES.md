# 功能對照表 — 怎麼接到「完整助理」

這份給想把助理養到「火力全開」的人：每個功能要連哪個**連接器**、怎麼設。
原型 `77`（Casper 的私人助理）的全部功能都對應在這。

> 設定頁 `/settings` 的「連接器（Connectors）」區會即時顯示每個連上沒、還缺哪些環境變數——照著補最直覺。逐步部署見 [ONBOARDING.md](./ONBOARDING.md)。

---

## 一、功能 → 要連什麼

| 功能 | 需要的連接器 | 設定方式 |
|---|---|---|
| 💬 對話（核心） | **LINE + Anthropic**（必備） | 環境變數 + webhook |
| 📅 行事曆 / 會議室 / 邀請與會者 | **Google** | `/oauth/connect` 授權 |
| 🧠 長期記憶（越用越懂你） | **Google**（OAuth + 試算表） | `/setup/memory` 建表 |
| ✅ 待辦清單 | **Google**（共用試算表） | 首次使用自動建分頁 |
| 🎓 Coach Inbox（coaching 速記） | **Google**（共用試算表） | 首次使用自動建分頁 |
| 👥 人脈管理（找人 / 互動 / 跟進 / 組織） | **Connectome** | `/setup/connectome` 驗證帳密 |
| 📚 決策日誌 / 知識庫問答 | **MyWiki** | 設 `MYWIKI_*`（⚠️ 見下方注意） |
| 🎙️ 語音訊息轉文字 | **OpenAI（Whisper）** | 設 `OPENAI_API_KEY` |
| 📨 晨報 / 週回顧 / 會議監看推播 | 上面有連到的能力 + 收件人 | 設 `OWNER_LINE_USER_ID` |
| 🗓️ 合併 Apple / iCloud 行事曆 | iCal（選用） | 設 `ICAL_FEED_URL` |
| 📎 PDF 摘要 / 白板照片整理 | 核心就有（走 Claude vision/document） | 免額外設定 |

---

## 二、最省力的接法（階梯式）

1. **核心** — `LINE_CHANNEL_SECRET`/`LINE_CHANNEL_ACCESS_TOKEN` + `ANTHROPIC_API_KEY` + `ASSISTANT_NAME`/`OWNER_NAME` → 會聊天的助理。
2. **連 Google（CP 值最高）** — `/oauth/connect` 拿 `GOOGLE_REFRESH_TOKEN`，再 `/setup/memory` 建試算表設 `MEMORY_SPREADSHEET_ID`。**一次開通：行事曆 + 長期記憶 + 待辦 + Coach Inbox + 推播基礎**（一半以上功能在這一步）。
3. **連 Connectome** — 填 `CONNECTOME_EMAIL` / `CONNECTOME_PASSWORD` → 人脈管理。
4. **連 OpenAI** — 設 `OPENAI_API_KEY` → 語音速記。
5. **開主動推播** — 傳訊息給 bot → 開 `/brief?key=SETUP_KEY` 查出你的 LINE userId → 設 `OWNER_LINE_USER_ID`（可選 `BRIEFING_TIME` / `WEEKLY_TIME`）。

完整環境變數清單見 [`.env.example`](./.env.example)。

---

## 三、三個要注意的點 ⚠️

1. **MyWiki 不只是填一把 API key** — 它是**另一個要自己部署的獨立專案**（不在這個 repo）。沒有自己的 MyWiki 部署就先跳過：框架預設關閉知識庫，不影響其他功能（連 system prompt 都不會提它）。
2. **Connectome 需要帳號** — 它是特定的人脈管理 App，要有 Connectome 帳號才連得上。沒有的人先不開人脈，或日後替框架加別的 CRM 連接器（contacts adapter 已預留，見 `contacts.js` 的 `PROVIDERS`）。
3. **Coach Inbox 的「電腦端歸檔系統」是原作者專屬** — 框架只提供「把 coaching 速記收進試算表」這段；下游那套 Coach 管理系統不在框架內。

---

## 四、能力是可插拔的

沒連的能力**不會出現**：工具不註冊、system prompt 不提、推播該區塊自動略過。所以你可以只開想要的：
- 只想要「聊天 + 行事曆」→ 只連 Google 就好。
- 只想要「聊天 + 人脈」→ 只連 Connectome。
- 全部都連 → 就是完整版。
