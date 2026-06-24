// Phase 6：Coach Inbox（coaching/輔導速記的雲端收件匣）
// 共用「77 記憶庫」試算表（MEMORY_SPREADSHEET_ID），新增分頁 coach_inbox。
// Casper 在 LINE 丟 coaching 速記 → 寫進這張分頁 → 電腦端的 Coach 管理系統
// （Cowork/Claude）定期讀取並歸檔成正式 session 紀錄。
// 注意：這裡只是「收件匣」，不是正式紀錄；歸檔與 Connectome 同步都在電腦端決定。
import { google } from "googleapis";
import { getAuthClient, calendarConfigured } from "./calendar.js";

const spreadsheetId = process.env.MEMORY_SPREADSHEET_ID;
const SHEET_TITLE = "coach_inbox";
const HEADER = ["時間", "session日期", "對象", "內容", "狀態"];

export const coachConfigured = Boolean(spreadsheetId && calendarConfigured);

let cachedSheets = null;
function sheetsApi() {
  if (cachedSheets) return cachedSheets;
  cachedSheets = google.sheets({ version: "v4", auth: getAuthClient() });
  return cachedSheets;
}

function requireConfigured() {
  if (!spreadsheetId) throw new Error("缺 MEMORY_SPREADSHEET_ID");
  if (!calendarConfigured) {
    throw new Error("Google 尚未授權（缺 GOOGLE_REFRESH_TOKEN）");
  }
}

function nowStamp() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date());
}

function todayStamp() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    dateStyle: "short",
  }).format(new Date());
}

// 確保 coach_inbox 分頁存在（第一次使用時自動建立，免去 setup 步驟）
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
      range: `${SHEET_TITLE}!A1:E1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADER] },
    });
  }
  ensured = true;
}

// 新增一筆 coaching 速記
export async function logCoachNote(person, content, sessionDate) {
  requireConfigured();
  await ensureSheet();
  const row = [
    nowStamp(),
    sessionDate || todayStamp(),
    person,
    content,
    "new",
  ];
  await sheetsApi().spreadsheets.values.append({
    spreadsheetId,
    range: `${SHEET_TITLE}!A:E`,
    valueInputOption: "RAW",
    requestBody: { values: [row] },
  });
  return { person, sessionDate: row[1], content };
}

// ── Coach Dashboard 雲端副本 ──────────────────────────────
// 電腦端產生的 dashboard.html 推送上來，存在同一份試算表的 coach_dashboard 分頁
// （切塊存多列，避開單一儲存格 50,000 字元上限），77 再用網頁路由吐回去。
const DASH_SHEET = "coach_dashboard";
const CHUNK = 40000;

async function ensureDashSheet() {
  const api = sheetsApi();
  const meta = await api.spreadsheets.get({ spreadsheetId });
  const exists = (meta.data.sheets || []).some(
    (s) => s.properties?.title === DASH_SHEET
  );
  if (!exists) {
    await api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: DASH_SHEET } } }],
      },
    });
  }
}

export async function saveDashboard(html) {
  requireConfigured();
  await ensureDashSheet();
  const api = sheetsApi();
  const chunks = [];
  for (let i = 0; i < html.length; i += CHUNK) {
    chunks.push([html.slice(i, i + CHUNK)]);
  }
  await api.spreadsheets.values.clear({
    spreadsheetId,
    range: `${DASH_SHEET}!A:A`,
  });
  await api.spreadsheets.values.update({
    spreadsheetId,
    range: `${DASH_SHEET}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: chunks },
  });
  return { bytes: html.length, chunks: chunks.length };
}

export async function loadDashboard() {
  requireConfigured();
  await ensureDashSheet();
  const res = await sheetsApi().spreadsheets.values.get({
    spreadsheetId,
    range: `${DASH_SHEET}!A:A`,
  });
  const rows = res.data.values || [];
  return rows.map((r) => r[0] || "").join("");
}

// 列出最近的速記（給 77 回答「我最近記了哪些 coaching」用）
export async function listCoachNotes(limit = 10) {
  requireConfigured();
  await ensureSheet();
  const res = await sheetsApi().spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_TITLE}!A2:E`,
  });
  const rows = res.data.values || [];
  return rows
    .map((r) => ({
      createdAt: r[0] || "",
      sessionDate: r[1] || "",
      person: r[2] || "",
      content: r[3] || "",
      status: r[4] || "",
    }))
    .filter((n) => n.content)
    .slice(-limit);
}
