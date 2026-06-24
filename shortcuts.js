// 個人快捷對照表（會議室、同事）。預設為空——自架者自己填。
//
// 三種填法（優先序：網頁設定頁覆寫 > 環境變數 > 空）：
//   1) /settings 網頁直接編輯（存進 settings 試算表的 rooms_json / contacts_json）。
//   2) 環境變數：
//      ROOMS_JSON='{"A":{"email":"...@resource.calendar.google.com","name":"大會議室"}}'
//      CONTACTS_JSON='{"小明":"ming@example.com"}'
// 助理會自動把這些對照寫進 system prompt，使用者講代號時就認得。
//
// 注意：rooms()/contacts() 每次呼叫即時計算（不凍結），所以網頁改完即時生效。
import { overrideOf } from "./settings.js";

function parseJson(settingKey, envKey) {
  const raw = (overrideOf(settingKey) ?? process.env[envKey] ?? "").trim();
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch {
    console.error(`⚠️ ${settingKey}/${envKey} 不是合法 JSON，已忽略`);
    return {};
  }
}

// 會議室資源：key 是口語代號，value = { email, name }。
export function rooms() {
  return parseJson("rooms_json", "ROOMS_JSON");
}

// 同事／常邀請的人：key 是口語稱呼，value 是 email。
export function contacts() {
  return parseJson("contacts_json", "CONTACTS_JSON");
}

// 把對照表轉成給助理的 system prompt 片段；沒有任何快捷時回空字串（不污染 prompt）。
export function shortcutsPromptSection() {
  const ROOMS = rooms();
  const CONTACTS = contacts();
  const hasRooms = Object.keys(ROOMS).length > 0;
  const hasContacts = Object.keys(CONTACTS).length > 0;
  if (!hasRooms && !hasContacts) return "";

  const parts = [];
  if (hasRooms) {
    const lines = Object.entries(ROOMS)
      .map(([key, r]) => `- 「${key}」→ ${r.name}（resource email: ${r.email}）`)
      .join("\n");
    parts.push(
      `# 你認識的會議室（使用者講代號時，把對應 resource email 放進 attendees，並把 location 設成會議室全名）
使用者可能會講「會議B」「開B」「訂B」等變體，都指代號 B 那間，依此類推。
${lines}`
    );
  }
  if (hasContacts) {
    const lines = Object.entries(CONTACTS)
      .map(([name, email]) => `- 「${name}」→ ${email}`)
      .join("\n");
    parts.push(
      `# 你認識的同事（使用者講名字／要邀請誰時，把對應 email 放進 attendees）
${lines}`
    );
  }
  parts.push(
    "提醒：若使用者提到你不認識的會議室代號或人名，照常處理或禮貌反問，不要亂猜 email。"
  );
  return parts.join("\n\n");
}
