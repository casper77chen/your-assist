# Your Assist

可自架的個人 LINE AI 助理框架（`Casper_Assist` 的框架化分支）。
改造理念、設計原則與里程碑見 [FRAMEWORK.md](./FRAMEWORK.md)；原始架構見 [ARCHITECTURE.md](./ARCHITECTURE.md)。

> ⚠️ 這是**框架**，不是某個人的部署。程式碼裡不寫死任何人的名字、公司、Zeabur 專案 ID、會議室或聯絡人——這些都走環境變數 / `profile.js` / `shortcuts.js`。改 code 時若發現又冒出 Casper/dentall 之類私有字串，就是還沒框架化乾淨，要抽掉。

## Zeabur 部署（本 fork 的參考部署；自己 fork 請換成你自己的）
- Project ID: `6a3b2d2ce41f9f1d1930387e`
- Service ID: `6a3b2d35e41f9f1d19303880`
- Server: Side_Project_A（Tokyo, server-69dc91575e919a56062ba518）

重新部署（務必帶 --service-id，否則會建重複服務）：
```bash
npx zeabur@latest deploy --project-id 6a3b2d2ce41f9f1d1930387e --service-id 6a3b2d35e41f9f1d19303880 --json
```
部署後要在 Zeabur 設環境變數（至少 `LINE_CHANNEL_SECRET`/`LINE_CHANNEL_ACCESS_TOKEN`/`ANTHROPIC_API_KEY`/`ASSISTANT_NAME`/`OWNER_NAME`/`SETUP_KEY`）並綁網域，webhook 指向 `https://網域/webhook`。完整步驟見 [ONBOARDING.md](./ONBOARDING.md)。

## 核心設計

- **能力即外掛**：每個模組（calendar / contacts / memory / coach / wiki / todos）由它自己的 `xxxConfigured`（=需要的 env 有沒有填）決定啟用。`TOOLS` 與 system prompt 依啟用的能力動態組裝。缺能力不該讓服務壞掉。
- **身分即設定**：助理名 / 主人稱呼 / 口吻 / 簡稱 → `profile.js`（讀 `ASSISTANT_NAME` / `OWNER_NAME` / `OWNER_NICKNAME` / `ASSISTANT_PERSONA` / `OWNER_ABBREVIATIONS`）。
- **人脈綁 Connectome**，但上層走 contacts adapter 介面（M4）。
- **知識庫（MyWiki）預設關閉**：沒設 `MYWIKI_*` 時工具不註冊、prompt 不提、記憶路由自動降路。

## 環境變數
見 `.env.example`。核心只要 `LINE_*` + `ANTHROPIC_API_KEY` + `ASSISTANT_NAME` / `OWNER_NAME`；其餘能力的變數填了才啟用。**勿把任何 secret 進 git。**

## 一次性設定路由（用 SETUP_KEY 保護）
- `/oauth/connect?key=SETUP_KEY` — Google 授權，拿 GOOGLE_REFRESH_TOKEN
- `/setup/memory?key=SETUP_KEY` — 建立／檢視長期記憶試算表
- `/setup/connectome?key=SETUP_KEY` — 驗證 Connectome 帳密
- `/brief?key=SETUP_KEY` — 立即補發晨報＋預覽；沒設 OWNER_LINE_USER_ID 時會顯示最近傳訊者的 userId

## 部署
框架不綁特定平台。部署到任何能跑 Node ≥20 的地方，設好環境變數、把 LINE webhook 指到 `/webhook` 即可。
