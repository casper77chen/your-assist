// 對話完整存檔（append-only，照日期累積，永不覆寫）。
// 存進「77 記憶庫」試算表的 transcript 分頁：一列 = 一則訊息。
// 跟 sessions（短期、會滾掉）並存、互不影響。首次使用自動建分頁，免 setup。
import { google } from "googleapis";
import { getAuthClient, calendarConfigured } from "./calendar.js";

const spreadsheetId = process.env.MEMORY_SPREADSHEET_ID;
const SHEET_TITLE = "transcript";
const HEADER = ["日期", "時間", "角色", "內容"];
const MAX_CHARS = 5000; // 單則內容上限

export const transcriptConfigured = Boolean(spreadsheetId && calendarConfigured);

let cachedSheets = null;
function sheetsApi() {
  if (cachedSheets) return cachedSheets;
  cachedSheets = google.sheets({ version: "v4", auth: getAuthClient() });
  return cachedSheets;
}

// 台北時間 → { date: "YYYY-MM-DD", time: "HH:MM:SS" }
function nowParts() {
  const s = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date());
  const [date, time = ""] = s.split(" ");
  return { date, time };
}

let ensured = false;
async function ensureSheet() {
  if (ensured) return;
  const api = sheetsApi();
  const meta = await api.spreadsheets.get({ spreadsheetId });
  const exists = (meta.data.sheets || []).some(
    (s) => s.properties?.title === SHEET_TITLE
  );
  if (!exists) {
    await api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: SHEET_TITLE } } }],
      },
    });
    await api.spreadsheets.values.update({
      spreadsheetId,
      range: `${SHEET_TITLE}!A1:D1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADER] },
    });
  }
  ensured = true;
}

// 寫一列存檔（role：「Casper」或「77」）。
async function logTranscript(role, content) {
  if (!transcriptConfigured || !content) return;
  await ensureSheet();
  const { date, time } = nowParts();
  await sheetsApi().spreadsheets.values.append({
    spreadsheetId,
    range: `${SHEET_TITLE}!A:D`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[date, time, role, String(content).slice(0, MAX_CHARS)]],
    },
  });
}

// 對外用：背景寫入、永不擋流程、失敗只記 log。
// 用一條序列化的 promise chain，確保多筆寫入照「呼叫順序」進表（Casper 先、77 後），
// 不會因為兩個 append 同時打而前後顛倒。
let writeChain = Promise.resolve();
export function recordTranscript(role, content) {
  if (!transcriptConfigured || !content) return;
  writeChain = writeChain
    .then(() => logTranscript(role, content))
    .catch((e) => console.error("存對話存檔失敗：", e.message));
}
