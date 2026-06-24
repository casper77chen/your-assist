// 短期對話記憶持久化：把每位使用者最近幾輪對話存進「77 記憶庫」試算表的
// sessions 分頁（一列 = 一位使用者），讓 77 重啟／重部署後不會失憶。
// 模式同 todos.js：首次使用自動建分頁，免 setup、免新環境變數。
import { google } from "googleapis";
import { getAuthClient, calendarConfigured } from "./calendar.js";

const spreadsheetId = process.env.MEMORY_SPREADSHEET_ID;
const SHEET_TITLE = "sessions";
const HEADER = ["使用者", "更新時間", "對話JSON"];
const MAX_TURNS = 12; // 最多存幾輪（跟 assistant.js 對齊）
const MAX_CHARS = 4000; // 每則內容上限，避免塞爆儲存格

export const sessionConfigured = Boolean(spreadsheetId && calendarConfigured);

let cachedSheets = null;
function sheetsApi() {
  if (cachedSheets) return cachedSheets;
  cachedSheets = google.sheets({ version: "v4", auth: getAuthClient() });
  return cachedSheets;
}

function nowStamp() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date());
}

// 把對話內容轉成純文字（圖片／PDF 只留佔位字，絕不把 base64 存進試算表）
function textify(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b?.type === "text") return b.text;
        if (b?.type === "image") return "（圖片）";
        if (b?.type === "document") return "（PDF 檔案）";
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
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
      range: `${SHEET_TITLE}!A1:C1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADER] },
    });
  }
  ensured = true;
}

// 載入某位使用者存著的對話（回 [{role, content:string}]，沒有就 []）
export async function loadSession(userId) {
  if (!sessionConfigured || !userId) return [];
  await ensureSheet();
  const res = await sheetsApi().spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_TITLE}!A2:C`,
  });
  const row = (res.data.values || []).find((r) => r[0] === userId);
  if (!row || !row[2]) return [];
  try {
    const arr = JSON.parse(row[2]);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (h) => h && h.role && typeof h.content === "string" && h.content
    );
  } catch {
    return [];
  }
}

// 存某位使用者目前的對話（最後 MAX_TURNS 輪；upsert 同一列）
export async function saveSession(userId, history) {
  if (!sessionConfigured || !userId) return;
  await ensureSheet();
  const safe = (history || [])
    .slice(-MAX_TURNS)
    .map((h) => ({ role: h.role, content: textify(h.content).slice(0, MAX_CHARS) }))
    .filter((h) => h.content);
  const row = [userId, nowStamp(), JSON.stringify(safe)];
  const api = sheetsApi();
  const res = await api.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_TITLE}!A2:A`,
  });
  const idx = (res.data.values || []).findIndex((r) => r[0] === userId);
  if (idx === -1) {
    await api.spreadsheets.values.append({
      spreadsheetId,
      range: `${SHEET_TITLE}!A:C`,
      valueInputOption: "RAW",
      requestBody: { values: [row] },
    });
  } else {
    const rowNumber = idx + 2;
    await api.spreadsheets.values.update({
      spreadsheetId,
      range: `${SHEET_TITLE}!A${rowNumber}:C${rowNumber}`,
      valueInputOption: "RAW",
      requestBody: { values: [row] },
    });
  }
}
