# Casper Assist — 個人 LINE AI 助理

> 目標：做一個住在 LINE 裡的個人助理，能管行事曆、客戶 CRM、飲食紀錄。
> 後端跑在 Zeabur，資料存在 Google 生態（Calendar / Sheets / Drive）。

---

## 1. 一句話架構

```
你 ──LINE訊息/照片──▶ LINE Platform ──webhook──▶ Zeabur 後端服務
                                                      │
                                                      ▼
                                            Claude API（大腦 + tool use）
                                                      │
                          ┌───────────────────────────┼───────────────────────────┐
                          ▼                           ▼                           ▼
                  Google Calendar             Google Sheets                Google Drive
                  （行事曆）                    （CRM / 飲食表格）            （照片 / 檔案）
```

訊息進來 → 後端把對話 + 工具清單交給 Claude → Claude 決定呼叫哪個工具 →
後端執行工具（寫日曆 / 寫 Sheet / 存檔）→ 結果回給 Claude → Claude 產生回覆 → 回傳 LINE。

---

## 2. 元件分層

### ① 入口層：LINE Messaging API
- 申請 **LINE Official Account** + **Messaging API channel**（LINE Developers Console）
- 拿到 `Channel access token` 和 `Channel secret`
- 設定 webhook URL（指向 Zeabur 服務的 `/webhook`）
- 收訊息：text / image（照片走 image message，LINE 提供 content API 下載圖片）
- 回訊息：reply API（5 秒內）或 push API（非同步）

### ② 後端服務（Zeabur）
- 技術選型：**Node.js + Express**（或 Python + FastAPI）。建議 Node，LINE SDK 成熟。
- 職責：
  - 驗證 LINE signature
  - 解析訊息（文字 / 圖片）
  - 維護「對話記憶」＋呼叫 Claude
  - 執行 Claude 要的工具（function calling）
  - 回覆 LINE
- 部署：Zeabur（你環境有 Zeabur 工具，可一鍵部署 + 綁網域）

### ③ 大腦：Claude API
- 模型：`claude-opus-4-8`（最強）或 `claude-sonnet-4-6`（快又省，日常助理夠用）
- 用 **tool use（function calling）** 定義工具：
  - `create_calendar_event(title, start, end, ...)`
  - `query_crm(name)` / `upsert_crm(...)`
  - `log_meal(date, items, photo_url, ...)`
  - `get_meal_report(period)`
- **prompt caching** 一定要開：system prompt（人格設定 + 工具說明）會重複，快取省錢省延遲。

### ④ 資料層：Google 生態
| 資料 | 存哪 | 為什麼 |
|---|---|---|
| 行事曆 | Google Calendar | 原生，手機自己也看得到 |
| 客戶 CRM | Google Sheets（一個 sheet = 一張表） | 免架 DB，你自己也能開來看/改 |
| 飲食紀錄 | Google Sheets + 照片存 Drive | 表格做統計，照片歸檔 |
| 其他檔案 | Google Drive | 一般檔案 |

存取方式：**Google OAuth 2.0**，拿 refresh token 後端長期使用。
（你環境裡已有 Google Calendar / Gmail / Drive 的 MCP，本機測試階段可直接用；正式部署則後端自己跑 OAuth。）

### ⑤ 記憶層
- **短期**：每個 LINE user 的近期對話（存記憶體 or Redis），讓它記得上下文。
- **長期**：使用者偏好、習慣 → 存一張 Google Sheet 或 Drive 上的 JSON，每次組 system prompt 時讀回。
- 進階（文中的「越用越懂你」）：把重要事實寫成「記憶檔」，之後 retrieval 注入。

---

## 3. 關鍵流程範例

### A. 「幫我設定明天上午九點約老王見面」
1. LINE webhook 收到文字
2. 後端 → Claude（帶 `create_calendar_event` 工具 + 今天日期）
3. Claude 解析時間（明天 09:00）→ 呼叫 `create_calendar_event`
4. 後端呼叫 Google Calendar API 建立事件
5. Claude 回覆「已幫你約明天 9:00 跟老王見面 ✅」→ 回 LINE

### B. 拍一張食物照片（什麼字都不打）
1. LINE webhook 收到 image
2. 後端用 LINE content API 下載圖片 → 上傳 Drive
3. 把圖片給 Claude（vision）→ 辨識食物內容
4. Claude 呼叫 `log_meal`（日期、品項、熱量估計、照片連結）
5. 寫入「飲食」Sheet
6. 回覆「記好了：午餐 雞腿便當，約 750 kcal。今天累積 1,400 kcal 👍」

---

## 4. 需要「人類才能做」的事（你要先準備的帳號/Token）

> 這對應文中「大部分都是申請雲端服務帳號拿 API token」。先列清楚，動工時照著拿。

- [ ] **LINE Developers** 帳號 → 建 Messaging API channel → 拿 token + secret
- [ ] **Anthropic API key**（Claude）— 或用 Zeabur AI Hub（OpenAI/Anthropic 相容，你環境有對應 skill）
- [ ] **Google Cloud Project** → 開 Calendar / Sheets / Drive API → OAuth client → 授權拿 refresh token
- [ ] **Zeabur** 帳號（你已有工具）→ 部署 + 綁網域
- [ ] **網域**（可在 Zeabur 直接買/綁）

---

## 5. 分階段實作計畫（每階段都可獨立驗收）

### Phase 0 — 骨架 + 回聲
- Express 服務、`/webhook` 收 LINE 訊息、原樣回覆（echo）
- 部署上 Zeabur，LINE 設好 webhook
- **驗收**：傳「哈囉」→ bot 回「哈囉」

### Phase 1 — 接上 Claude（純對話）
- 訊息進 Claude → 回覆，加上人格 system prompt
- 加短期對話記憶
- **驗收**：能自然聊天、記得前一句

### Phase 2 — 行事曆工具（第一個真功能）
- 接 Google Calendar OAuth + `create_calendar_event` tool
- **驗收**：「幫我約明天九點見老王」→ 日曆出現事件（= 文中 the moment of truth）

### Phase 3 — CRM（Google Sheets）
- `query_crm` / `upsert_crm` tool，一張客戶表
- **驗收**：「記一下客戶王小明，電話 0912…」→ Sheet 多一列；「王小明電話多少」→ 查得到

### Phase 4 — 飲食紀錄 + 照片 + Vision
- 圖片下載 → Drive、Claude vision 辨識 → `log_meal` 寫 Sheet
- 週期統計報告
- **驗收**：拍照 → 自動歸檔 + 熱量回報

### Phase 5 — 長期記憶 / 技能累積
- 偏好記憶、可擴充 skill 機制
- 越用越懂你

---

## 6. 技術風險 / 注意事項
- **LINE reply token 5 秒過期**：Claude 推理可能 >5 秒 → 用 push API 或先回「處理中…」
- **OAuth refresh token 失效**：要做 token 自動更新 + 失效通知
- **多人使用**：若以後要給朋友用，每個 user 要各自綁自己的 Google 帳號 → 需要 per-user OAuth 流程（這是文中作者賣點之一，難點也在這）
- **成本**：Claude API 按 token 計費，開 prompt caching + 日常用 Sonnet 控制成本
- **安全**：webhook 驗 signature、token 放環境變數別進 git

---

## 7. 建議的下一步
先做 **Phase 0 + 1**（骨架 + 能聊天），這是 1~2 小時內能看到東西在 LINE 上動的程度。
拿到 LINE token 和 Anthropic key 後就能開工。
