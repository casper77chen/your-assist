// Phase 5：長期記憶（存在 Google Sheets，越用越懂 Casper）
// 一份試算表「77 記憶庫」，分頁 memory，一列 = 一則記憶。
// 為了不每則訊息都打 Sheets，載入一次後放 RAM 快取；新增/刪除後 resync。
import { google } from "googleapis";
import { getAuthClient, calendarConfigured } from "./calendar.js";
import { ownerName } from "./profile.js";

const spreadsheetId = process.env.MEMORY_SPREADSHEET_ID;
const SHEET_TITLE = "memory";
const HEADER = ["時間", "使用者", "分類", "內容"];

export const memoryConfigured = Boolean(spreadsheetId && calendarConfigured);

let cachedSheets = null;
function sheetsApi() {
  if (cachedSheets) return cachedSheets;
  cachedSheets = google.sheets({ version: "v4", auth: getAuthClient() });
  return cachedSheets;
}

// RAM 快取：null = 尚未載入；array = 已載入
let cache = null;
let cachedSheetId = null; // memory 分頁的 gid（刪列用）

function requireConfigured() {
  if (!spreadsheetId) throw new Error("缺 MEMORY_SPREADSHEET_ID");
  if (!calendarConfigured) {
    throw new Error("Google 尚未授權（缺 GOOGLE_REFRESH_TOKEN）");
  }
}

// 台北時間戳，方便你在試算表裡讀
function nowStamp() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date());
}

// 找出 memory 分頁的 sheetId（gid）
async function getSheetId() {
  if (cachedSheetId !== null) return cachedSheetId;
  const meta = await sheetsApi().spreadsheets.get({ spreadsheetId });
  const sheet = (meta.data.sheets || []).find(
    (s) => s.properties?.title === SHEET_TITLE
  );
  if (!sheet) throw new Error(`試算表裡找不到分頁「${SHEET_TITLE}」`);
  cachedSheetId = sheet.properties.sheetId;
  return cachedSheetId;
}

// 讀全部記憶 → 填 RAM 快取並回傳
export async function loadMemories() {
  requireConfigured();
  const res = await sheetsApi().spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_TITLE}!A2:D`,
  });
  const rows = res.data.values || [];
  cache = rows
    .map((r, i) => ({
      rowNumber: i + 2, // 試算表實際列號（A1 是表頭）
      createdAt: r[0] || "",
      userId: r[1] || "",
      category: r[2] || "",
      content: r[3] || "",
    }))
    .filter((m) => m.content);
  return cache;
}

// 取得目前記憶（lazy 載入）；未設定就回空陣列。
// 載入失敗（例如 Google token 刷新掛了）時：記下 log、回空陣列、不設快取，
// 讓 77 仍能正常聊天（只是這次少了長期記憶），且下一則訊息會自動重試載入。
export async function getMemories() {
  if (!memoryConfigured) return [];
  if (cache === null) {
    try {
      await loadMemories();
    } catch (e) {
      console.error("載入長期記憶失敗（先略過記憶，不影響聊天）：", e.message);
      return [];
    }
  }
  return cache || [];
}

// 新增一則記憶
export async function addMemory(userId, category, content) {
  requireConfigured();
  const createdAt = nowStamp();
  await sheetsApi().spreadsheets.values.append({
    spreadsheetId,
    range: `${SHEET_TITLE}!A:D`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[createdAt, userId || "", category || "", content]],
    },
  });
  await loadMemories(); // resync 快取（含正確 rowNumber）
  return cache[cache.length - 1] || { createdAt, userId, category, content };
}

// 刪除一則記憶（id 是 getMemories() 清單裡的 1-based 編號）
export async function forgetMemory(id) {
  requireConfigured();
  await getMemories();
  const target = cache[id - 1];
  if (!target) return null;
  const sheetId = await getSheetId();
  await sheetsApi().spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: target.rowNumber - 1, // 0-based
              endIndex: target.rowNumber,
            },
          },
        },
      ],
    },
  });
  await loadMemories();
  return target;
}

// 把記憶轉成 system prompt 片段（含編號，讓 77 能精準 forget）
export function memoryPromptSection(memories) {
  const owner = ownerName();
  if (!memories || memories.length === 0) {
    return `# 關於 ${owner} 的長期記憶\n（目前沒有任何長期記憶。當你學到值得長期記住的事實或偏好時，用 remember 工具記下來。）`;
  }
  const lines = memories
    .map(
      (m, i) =>
        `${i + 1}. ${m.category ? `【${m.category}】` : ""}${m.content}`
    )
    .join("\n");
  return `# 關於 ${owner} 的長期記憶（越用越懂他）
以下是你長期記住、關於 ${owner} 的事實與偏好。回答時自然運用，不用刻意提起：
${lines}

（要刪除某條記憶時，用 forget 工具帶上該條前面的編號。）`;
}

// 建立記憶試算表（給 /setup/memory 用，尚未有 MEMORY_SPREADSHEET_ID 時）
export async function createMemorySpreadsheet() {
  if (!calendarConfigured) {
    throw new Error("Google 尚未授權（缺 GOOGLE_REFRESH_TOKEN）");
  }
  const api = sheetsApi();
  const res = await api.spreadsheets.create({
    requestBody: {
      properties: { title: "77 記憶庫" },
      sheets: [{ properties: { title: SHEET_TITLE } }],
    },
  });
  const id = res.data.spreadsheetId;
  await api.spreadsheets.values.update({
    spreadsheetId: id,
    range: `${SHEET_TITLE}!A1:D1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADER] },
  });
  return id;
}
