// 連接器（Connector）登錄表 — 把每個可連結的外部系統做成一張「卡」。
//
// 概念類似各家 AI 的 connector：使用者在 /settings 選擇要連哪些外部帳號，
// 接起來，對應的能力就開（例如連上 Connectome → 人脈管理可用）。
// 框架原則：要新增一個可連結的系統，只在這裡加一筆 + 提供它的 xxxConfigured 旗標即可，
// 設定頁會自動長出那張連接卡。
//
// 粒度＝「要連的外部帳號 / 服務」：
//   - Google 一個帳號連上去，一次開通 行事曆 / 記憶 / 待辦 / Coach（都存你自己的 Google）。
//   - Connectome / MyWiki / OpenAI 各自獨立。
//   - LINE + Anthropic 是核心（一定要有），不算可選連接器，不列在這。
import { contactsConfigured, contactsProvider } from "./contacts.js";
import { calendarConfigured } from "./calendar.js";
import { memoryConfigured } from "./memory.js";
import { todosConfigured } from "./todos.js";
import { coachConfigured } from "./coach.js";
import { mywikiConfigured } from "./mywiki.js";
import { transcribeConfigured } from "./transcribe.js";

const present = (k) => Boolean((process.env[k] || "").trim());

export const CONNECTORS = [
  {
    id: "connectome",
    name: "Connectome",
    category: "人脈管理",
    blurb:
      "用既有的 Connectome App 當人脈庫——接起來就能用 LINE 找人、建檔、記互動、追跟進、管組織關係。",
    enables: ["人脈管理（找人 / 建檔 / 記互動 / 待約 / 組織關係）"],
    requires: ["CONNECTOME_EMAIL", "CONNECTOME_PASSWORD"],
    optional: ["CONNECTOME_BASE_URL"],
    setupPath: "/setup/connectome",
    setupLabel: "驗證連線",
    connected: () => contactsConfigured,
    note: () => (contactsConfigured ? `provider：${contactsProvider}` : ""),
  },
  {
    id: "google",
    name: "Google（Calendar + Sheets）",
    category: "行事曆・記憶・待辦",
    blurb:
      "連上 Google 帳號，一次開通：行事曆/會議室、長期記憶、待辦、Coach Inbox。資料都存在你自己的 Google。",
    enables: ["行事曆 / 會議室", "長期記憶", "待辦", "Coach Inbox"],
    requires: [
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "GOOGLE_REFRESH_TOKEN",
      "MEMORY_SPREADSHEET_ID",
    ],
    setupPath: "/oauth/connect",
    setupLabel: "授權 Google",
    connected: () => calendarConfigured,
    // 子能力狀態（行事曆連上但記憶/待辦/Coach 還需要 MEMORY_SPREADSHEET_ID）
    note: () => {
      if (!calendarConfigured) return "";
      const extra = memoryConfigured ? "記憶/待辦/Coach 已開" : "記憶/待辦/Coach 還缺 MEMORY_SPREADSHEET_ID";
      return extra;
    },
  },
  {
    id: "mywiki",
    name: "MyWiki",
    category: "決策日誌・知識庫",
    blurb:
      "把決策與重要知識送進 MyWiki，事後可問「我當初為什麼決定…」。（選用）",
    enables: ["決策日誌（log_decision）", "知識庫問答（ask_wiki）"],
    requires: ["MYWIKI_BASE_URL", "MYWIKI_API_KEY"],
    setupPath: null,
    connected: () => mywikiConfigured,
    note: () => "",
  },
  {
    id: "openai",
    name: "OpenAI（Whisper）",
    category: "語音轉文字",
    blurb: "LINE 語音訊息自動轉文字再進正常流程。（選用）",
    enables: ["語音速記"],
    requires: ["OPENAI_API_KEY"],
    setupPath: null,
    connected: () => transcribeConfigured,
    note: () => "",
  },
];

// 給設定頁用：附上即時連線狀態與「還缺哪些環境變數」。
export function listConnectors() {
  return CONNECTORS.map((c) => ({
    id: c.id,
    name: c.name,
    category: c.category,
    blurb: c.blurb,
    enables: c.enables,
    requires: c.requires,
    optional: c.optional || [],
    setupPath: c.setupPath,
    setupLabel: c.setupLabel || "連結",
    isConnected: c.connected(),
    missing: c.requires.filter((k) => !present(k)),
    note: c.note ? c.note() : "",
  }));
}
