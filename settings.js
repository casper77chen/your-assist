// 設定覆寫儲存層：把「網頁設定頁改過的值」存進記憶庫試算表的 settings 分頁。
// 模式同 session.js / todos.js：首次使用自動建分頁，免 setup、免新環境變數。
//
// 設計重點（呼應 FRAMEWORK.md 的「可編輯一切但不會改壞」）：
// - 這裡只存「使用者改過的『覆寫』」，每個設定的「預設值」寫死在 code（profile.js / prompt 區塊）。
//   讀取時的層級永遠是：覆寫(settings) → 環境變數(env) → 程式預設(default)。
// - 所以任何設定都能「還原預設」＝把這裡的覆寫刪掉即可，永遠救得回來、不會把助理鎖死。
// - 沒接 Google Sheets（minimal 部署）時：settingsWritable=false，設定頁唯讀，全部回退 env/default。
import { google } from "googleapis";
import { getAuthClient, calendarConfigured } from "./calendar.js";

const spreadsheetId = process.env.MEMORY_SPREADSHEET_ID;
const SHEET_TITLE = "settings";
const HEADER = ["鍵", "更新時間", "值"];

// 有試算表才能「寫」設定；沒有時設定頁唯讀（值全來自 env/default）。
export const settingsWritable = Boolean(spreadsheetId && calendarConfigured);

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

// ── 同步快取：profile.js 等模組要能「不 await」就讀到覆寫值 ──
// 啟動時呼叫 loadSettings() 填好；每次寫入後刷新。沒載過就是 {}（全回退 env/default）。
let cache = {};
let loaded = false;

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

// 從試算表載入所有覆寫進同步快取（啟動時 + 寫入後呼叫）。回傳快取物件。
export async function loadSettings() {
  if (!settingsWritable) {
    loaded = true;
    return cache;
  }
  try {
    await ensureSheet();
    const res = await sheetsApi().spreadsheets.values.get({
      spreadsheetId,
      range: `${SHEET_TITLE}!A2:C`,
    });
    const next = {};
    for (const row of res.data.values || []) {
      const key = (row[0] || "").trim();
      if (key) next[key] = row[2] ?? "";
    }
    cache = next;
    loaded = true;
  } catch (err) {
    console.error("⚠️ 載入 settings 失敗，暫用現有快取：", err.message);
  }
  return cache;
}

// 同步讀一個覆寫值（沒有就回 undefined）。空白字串視為「沒覆寫」→ 回退 env/default。
export function overrideOf(key) {
  if (!loaded) return undefined;
  const v = cache[key];
  if (v === undefined || v === null) return undefined;
  const s = String(v);
  return s.trim() === "" ? undefined : s;
}

// 回傳目前所有覆寫（給設定頁顯示「哪些被改過」用）。
export function allOverrides() {
  return { ...cache };
}

// upsert 一個覆寫（值留空白＝視同還原預設，會把該列刪掉）。
export async function setSetting(key, value) {
  if (!settingsWritable) throw new Error("未接 Google Sheets，無法儲存設定");
  key = String(key || "").trim();
  if (!key) throw new Error("缺少設定鍵");
  if (value === undefined || value === null || String(value).trim() === "") {
    return resetSetting(key);
  }
  await ensureSheet();
  const api = sheetsApi();
  const res = await api.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_TITLE}!A2:A`,
  });
  const idx = (res.data.values || []).findIndex((r) => (r[0] || "").trim() === key);
  const row = [key, nowStamp(), String(value)];
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
  cache[key] = String(value); // 同步刷新快取，立即生效
}

// 批次寫入（設定頁一次存多個欄位）。
export async function setSettings(obj) {
  for (const [k, v] of Object.entries(obj || {})) {
    await setSetting(k, v);
  }
}

// 還原單一設定（刪掉覆寫列）。Sheets 不易刪單列 → 改寫成空值並從快取移除。
export async function resetSetting(key) {
  key = String(key || "").trim();
  if (!key) return;
  delete cache[key];
  if (!settingsWritable) return;
  await ensureSheet();
  const api = sheetsApi();
  const res = await api.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_TITLE}!A2:A`,
  });
  const idx = (res.data.values || []).findIndex((r) => (r[0] || "").trim() === key);
  if (idx === -1) return;
  const rowNumber = idx + 2;
  await api.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_TITLE}!A${rowNumber}:C${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: { values: [[key, nowStamp(), ""]] }, // 留空＝回退預設
  });
}

// 全域逃生門：清掉所有覆寫，整個助理回到 code 預設。
export async function resetAll() {
  const keys = Object.keys(cache);
  for (const k of keys) await resetSetting(k);
}
