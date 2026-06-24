import { google } from "googleapis";
import { icalConfigured, listIcalEvents } from "./ical.js";

// ── 環境變數 ──────────────────────────────────────────────
const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
// OAuth 以「你本人」身分操作，所以 primary 就是你的主日曆
const calendarId = process.env.GOOGLE_CALENDAR_ID || "primary";
const redirectUri =
  process.env.OAUTH_REDIRECT_URI ||
  "https://casper-assist.zeabur.app/oauth/callback";

export const TIME_ZONE = "Asia/Taipei";
// calendar 涵蓋讀寫事件 + 列出日曆（挖會議室用）；spreadsheets 給長期記憶（Phase 5）用
const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/spreadsheets",
];

export const oauthClientConfigured = Boolean(clientId && clientSecret);
export const calendarConfigured = Boolean(
  clientId && clientSecret && refreshToken
);

function makeOAuthClient() {
  if (!oauthClientConfigured) {
    throw new Error("缺 GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET");
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// 一次性授權流程用 ──────────────────────────────────────────
export function getAuthUrl(state) {
  return makeOAuthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // 確保拿得到 refresh_token
    scope: SCOPES,
    state,
  });
}

export async function exchangeCode(code) {
  const { tokens } = await makeOAuthClient().getToken(code);
  return tokens; // { refresh_token, access_token, ... }
}

// 日常操作用 ────────────────────────────────────────────────
// 共用的「已帶 refresh token」OAuth client，calendar / sheets（記憶）都用它
let cachedAuthClient = null;
export function getAuthClient() {
  if (cachedAuthClient) return cachedAuthClient;
  if (!calendarConfigured) {
    throw new Error("Google 尚未授權（缺 GOOGLE_REFRESH_TOKEN）");
  }
  const client = makeOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });
  cachedAuthClient = client;
  return cachedAuthClient;
}

let cachedCal = null;
function cal() {
  if (cachedCal) return cachedCal;
  cachedCal = google.calendar({ version: "v3", auth: getAuthClient() });
  return cachedCal;
}

/**
 * 建立事件。attendees 是 email 陣列（人或會議室資源都算 attendee）。
 * @param {{title:string,start:string,end:string,location?:string,description?:string,attendees?:string[]}} ev
 */
export async function createEvent({
  title,
  start,
  end,
  location,
  description,
  attendees,
}) {
  const api = cal();
  const requestBody = {
    summary: title,
    location,
    description,
    start: { dateTime: start, timeZone: TIME_ZONE },
    end: { dateTime: end, timeZone: TIME_ZONE },
  };
  if (attendees && attendees.length) {
    requestBody.attendees = attendees.map((email) => ({ email }));
  }
  const res = await api.events.insert({
    calendarId,
    requestBody,
    sendUpdates: "all", // 寄邀請信給與會者 / 會議室
  });
  return { htmlLink: res.data.htmlLink, id: res.data.id };
}

/**
 * 查會議室在某段時間的忙碌（已被預約）區間。用 Google freebusy API，
 * 因為 Casper 看得到這些會議室資源日曆，所以查得到別人的預約。
 * @param {{roomEmails:string[],start:string,end:string}} q
 * @returns {Promise<Array<{email:string,busy:Array<{start:string,end:string}>,error?:string}>>}
 */
export async function checkRoomAvailability({ roomEmails, start, end }) {
  const api = cal();
  const res = await api.freebusy.query({
    requestBody: {
      timeMin: start,
      timeMax: end,
      timeZone: TIME_ZONE,
      items: roomEmails.map((id) => ({ id })),
    },
  });
  const calendars = res.data.calendars || {};
  return roomEmails.map((email) => {
    const c = calendars[email] || {};
    return {
      email,
      busy: c.busy || [],
      // 若 Casper 沒有該資源的讀取權限，Google 會在 errors 回報
      error: c.errors?.[0]?.reason,
    };
  });
}

/**
 * 列出會議室在某段時間的實際行程（含標題）。比 freebusy 多了「是什麼活動」。
 * 用來回答「SPACE 有沒有課／有什麼課」。讀的是該資源日曆上的事件，
 * 標題是否看得到取決於 dentall 帳號對該資源的權限（reader 才看得到標題）。
 * @param {{roomEmails:string[],start:string,end:string}} q
 * @returns {Promise<Array<{email:string,events:Array<{title:string,start:string,end:string}>,error?:string}>>}
 */
export async function listRoomEvents({ roomEmails, start, end }) {
  const api = cal();
  return Promise.all(
    roomEmails.map(async (email) => {
      try {
        const res = await api.events.list({
          calendarId: email,
          timeMin: start,
          timeMax: end,
          singleEvents: true,
          orderBy: "startTime",
          maxResults: 100,
        });
        const events = (res.data.items || [])
          .filter((ev) => ev.status !== "cancelled")
          .map((ev) => ({
            // 只有 freeBusyReader 權限時 summary 會是空的，給個 fallback
            title: ev.summary || "（不公開／無標題的預約）",
            start: ev.start?.dateTime || ev.start?.date,
            end: ev.end?.dateTime || ev.end?.date,
          }));
        return { email, events };
      } catch (e) {
        return {
          email,
          events: [],
          error: e?.errors?.[0]?.reason || e?.message || "讀取失敗",
        };
      }
    })
  );
}

/**
 * 列出 Casper 主日曆在某段時間的行程（晨報、會議監看用）。
 * attendees 含 self / resource 標記，讓呼叫端能挑出「別的人類與會者」。
 * @param {{start:string,end:string}} q ISO 8601 含時區
 * @returns {Promise<Array<{id:string,title:string,start:string,end:string,location?:string,allDay:boolean,attendees:Array<{email:string,name?:string,self:boolean,resource:boolean,responseStatus?:string}>}>>}
 */
export async function listMyEvents({ start, end }) {
  const api = cal();
  const res = await api.events.list({
    calendarId,
    timeMin: start,
    timeMax: end,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 50,
  });
  return (res.data.items || [])
    .filter((ev) => ev.status !== "cancelled")
    .map((ev) => ({
      id: ev.id,
      title: ev.summary || "（無標題）",
      start: ev.start?.dateTime || ev.start?.date,
      end: ev.end?.dateTime || ev.end?.date,
      location: ev.location || undefined,
      allDay: !ev.start?.dateTime,
      attendees: (ev.attendees || []).map((a) => ({
        email: a.email,
        name: a.displayName || undefined,
        self: Boolean(a.self),
        resource: Boolean(a.resource) || (a.email || "").endsWith("resource.calendar.google.com"),
        responseStatus: a.responseStatus,
      })),
    }));
}

// 標題主體：去掉後面的括號附註（半形/全形都算）與空白，給去重比對用。
// 例：「Dr Ryu x dentall (使用說明欄的連結）」→「drryuxdentall」
function eventCoreTitle(title) {
  return (title || "")
    .replace(/[(（].*$/, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

// 已人工確認「其實是同一場、但標題不同」的行程群組（常見於同一場在 Google 與
// iCal 各自取了不同名字）。起訖時間相同時，群組內的標題會被當同名一起去重。
// 不動日曆，只影響 77 通知。日後再發現可疑的同一場，問過 Casper 確認才加進來。
const SAME_EVENT_GROUPS = [
  ["牙科領袖營會議", "牙科領袖營籌備會議"],
];
// core title → 該群組的代表 core title
const TITLE_ALIAS = new Map();
for (const group of SAME_EVENT_GROUPS) {
  const canon = eventCoreTitle(group[0]);
  for (const t of group) TITLE_ALIAS.set(eventCoreTitle(t), canon);
}

/**
 * 同一場行程在日曆上被重複建立（不同 Meet 連結、或不小心建兩次），
 * 或同一場在不同日曆取了不同名字時，77 對外通知不該重複顯示。
 * 判定「同一場」= 起訖時間相同 + 標題主體相同（或在 SAME_EVENT_GROUPS 同群）。
 * 只在彙整通知時去重，不動日曆本身。保留第一筆。
 * @template {{title:string,start:string,end:string}} T
 * @param {T[]} events
 * @returns {T[]}
 */
export function dedupeEvents(events) {
  const seen = new Set();
  const out = [];
  for (const e of events || []) {
    const core = eventCoreTitle(e.title);
    const canon = TITLE_ALIAS.get(core) ?? core;
    // 以絕對時刻比對，讓 Google（+08:00）與 iCal（Z）的同一場行程也對得上
    const key = `${Date.parse(e.start)}|${Date.parse(e.end)}|${canon}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/**
 * 合併讀取：Google 主日曆 + 所有 iCal 訂閱（若有設 ICAL_FEED_URL），
 * 依開始時間排序後去重。Google 在前，所以同一場以 Google 那筆為準
 * （保留 id／與會者／地點等完整資訊）。晨報、週回顧用這個當資料源。
 * @param {{start:string,end:string}} q ISO 8601
 */
export async function listMergedEvents({ start, end }) {
  const [googleEvents, icalEvents] = await Promise.all([
    listMyEvents({ start, end }),
    icalConfigured ? listIcalEvents({ start, end }) : Promise.resolve([]),
  ]);
  const merged = [...googleEvents, ...icalEvents].sort(
    (a, b) => Date.parse(a.start) - Date.parse(b.start)
  );
  return dedupeEvents(merged);
}

/**
 * 從最近 ~120 天與未來的事件挖出曾用過的會議室資源（給 setup 用）。
 * @returns {Promise<Array<{email:string,name:string}>>}
 */
export async function discoverRooms() {
  const api = cal();
  const timeMin = new Date(Date.now() - 120 * 24 * 3600 * 1000).toISOString();
  const res = await api.events.list({
    calendarId,
    timeMin,
    maxResults: 250,
    singleEvents: true,
    orderBy: "startTime",
  });
  const rooms = new Map();
  for (const ev of res.data.items || []) {
    for (const a of ev.attendees || []) {
      if (a.email && a.email.endsWith("resource.calendar.google.com")) {
        rooms.set(a.email, a.displayName || a.email);
      }
    }
  }
  return [...rooms.entries()].map(([email, name]) => ({ email, name }));
}
