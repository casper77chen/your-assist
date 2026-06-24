// Phase 8：待辦清單（介於日曆與長期記憶之間的「要做的事」）
// 共用「77 記憶庫」試算表（MEMORY_SPREADSHEET_ID），新增分頁 todos。
// 模式同 session.js：首次使用自動建分頁，免 setup、免新環境變數。
import { google } from "googleapis";
import { getAuthClient, calendarConfigured } from "./calendar.js";

const spreadsheetId = process.env.MEMORY_SPREADSHEET_ID;
const SHEET_TITLE = "todos";
const HEADER = ["建立時間", "到期日", "事項", "狀態"];

export const todosConfigured = Boolean(spreadsheetId && calendarConfigured);

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

async function loadRows() {
  const res = await sheetsApi().spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_TITLE}!A2:D`,
  });
  const rows = res.data.values || [];
  return rows
    .map((r, i) => ({
      rowNumber: i + 2, // 試算表實際列號（更新狀態用）
      createdAt: r[0] || "",
      due: r[1] || "",
      content: r[2] || "",
      status: r[3] || "",
    }))
    .filter((t) => t.content);
}

// 新增一筆待辦。dueDate 可選（YYYY-MM-DD）。
export async function addTodo(content, dueDate) {
  requireConfigured();
  await ensureSheet();
  const row = [nowStamp(), dueDate || "", content, "open"];
  await sheetsApi().spreadsheets.values.append({
    spreadsheetId,
    range: `${SHEET_TITLE}!A:D`,
    valueInputOption: "RAW",
    requestBody: { values: [row] },
  });
  return { content, due: row[1] };
}

// 列出待辦：預設只列未完成（依到期日排前面、沒到期日的排後面），編號 1-based 給使用者指認。
export async function listTodos(includeDone = false) {
  requireConfigured();
  await ensureSheet();
  const all = await loadRows();
  const items = includeDone ? all : all.filter((t) => t.status !== "done");
  return items
    .sort((a, b) => (a.due || "9999") < (b.due || "9999") ? -1 : 1)
    .map((t, i) => ({ ...t, id: i + 1 }));
}

// 完成第 N 筆（N 是 listTodos 回的 1-based 編號，現算現對，個人單用足夠）。
export async function completeTodo(todoId) {
  requireConfigured();
  await ensureSheet();
  const items = await listTodos(false);
  const target = items.find((t) => t.id === todoId);
  if (!target) return null;
  await sheetsApi().spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_TITLE}!D${target.rowNumber}`,
    valueInputOption: "RAW",
    requestBody: { values: [["done"]] },
  });
  return target;
}
