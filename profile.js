// 助理身分／品牌設定層。
// 把「這個助理叫什麼、是給誰用、口吻如何」從程式碼抽出來，自架者只要設環境變數即可，
// 也可以在 /settings 網頁即時改（覆寫存進 settings 試算表）。
//
// 讀取層級（settings.js 的核心約定）：覆寫(settings) → 環境變數(env) → 程式預設(default)。
// 因此網頁改的值即時生效，留空＝還原預設，永遠救得回來。
import { overrideOf } from "./settings.js";

// 讀 env：空字串／空白一律當「沒設」回 undefined，這樣 ?? 才會正確往預設回退。
const env = (k) => {
  const v = (process.env[k] || "").trim();
  return v === "" ? undefined : v;
};

// 三層解析：先看網頁覆寫，再看 env，最後用內建預設。
function resolve(settingKey, envKey, fallback) {
  return overrideOf(settingKey) ?? env(envKey) ?? fallback ?? "";
}

// 每個欄位都用 getter，確保「每次讀都拿當下的值」（網頁改完不必重啟）。
export const assistantName = () => resolve("assistant_name", "ASSISTANT_NAME", "小助");
export const ownerName = () => resolve("owner_name", "OWNER_NAME", "主人");
export const ownerNickname = () =>
  overrideOf("owner_nickname") ?? env("OWNER_NICKNAME") ?? ownerName();
export const extraPersona = () => resolve("assistant_persona", "ASSISTANT_PERSONA", "");

// 主人常用的專案／工具簡稱對照（選填）。
// 格式：「簡稱=全名,簡稱=全名」，例如 "con=人脈庫,wiki=知識庫"。
export function abbreviations() {
  const raw = resolve("owner_abbreviations", "OWNER_ABBREVIATIONS", "");
  if (!raw) return [];
  return raw
    .split(",")
    .map((pair) => pair.split("="))
    .filter(([k, v]) => k && v)
    .map(([k, v]) => [k.trim(), v.trim()]);
}

// 核心人格段落（取代 assistant.js 裡寫死的開頭）。
// 只放「身分 + 通用口吻」，能力相關的規則由各能力模組／prompt 區塊貢獻。
export function identityPromptSection() {
  const name = assistantName();
  const owner = ownerName();
  const abbr = abbreviations();
  const abbrLine = abbr.length
    ? `\n- ${owner} 常用簡稱：${abbr
        .map(([k, v]) => `**${k}**＝${v}`)
        .join("、")}。看到簡稱直接對應，不用追問。`
    : "";
  const persona = extraPersona() ? `\n- ${extraPersona()}` : "";

  return `你是「${name}」，${owner} 的個人 AI 助理，住在 LINE 裡。

個性與風格：
- 像一個老練、可靠、思慮周全的私人助理，溫暖但不囉嗦。
- 用繁體中文、台灣口語回覆。預設簡短，除非使用者要你詳細說明。
- 回覆要適合手機閱讀：精簡、重點清楚，少用冗長段落。${abbrLine}${persona}`;
}
