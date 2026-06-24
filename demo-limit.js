// Demo 用量護欄。
// 情境：用「一把 Anthropic key（部署者付費）」開一個可公開試玩的 demo bot。
// 為了不被刷爆/燒錢，限制每位 LINE 使用者每天的訊息數（可選全域每日上限、白名單）。
//
// 純記憶體計數，每天台北 00:00 歸零（重啟也歸零——對 demo 夠用，且偏寬鬆無妨）。
// 沒設任何上限時 demoLimitOn=false，完全不影響一般自架部署。
//
// 環境變數：
//   DEMO_DAILY_LIMIT         每位使用者每天上限（>0 才啟用 demo 護欄）
//   DEMO_GLOBAL_DAILY_LIMIT  全域每天總上限（選用，0=不限）
//   DEMO_ALLOWLIST           逗號分隔的 LINE userId，不受限（放你自己）
const TZ = "Asia/Taipei";
const PER_USER = parseInt(process.env.DEMO_DAILY_LIMIT || "0", 10) || 0;
const GLOBAL = parseInt(process.env.DEMO_GLOBAL_DAILY_LIMIT || "0", 10) || 0;
const ALLOWLIST = new Set(
  (process.env.DEMO_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const REPO_URL = "https://github.com/casper77chen/your-assist";

export const demoLimitOn = PER_USER > 0 || GLOBAL > 0;

let day = null;
let perUser = new Map();
let globalCount = 0;

function today() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, dateStyle: "short" }).format(
    new Date()
  );
}
function rollover() {
  const d = today();
  if (d !== day) {
    day = d;
    perUser = new Map();
    globalCount = 0;
  }
}

// 呼叫 Claude 前先問：這位使用者這則可以放行嗎？
export function checkDemoLimit(userId) {
  if (!demoLimitOn) return { allowed: true };
  if (userId && ALLOWLIST.has(userId)) return { allowed: true };
  rollover();
  if (GLOBAL > 0 && globalCount >= GLOBAL) return { allowed: false, reason: "global" };
  const used = perUser.get(userId) || 0;
  if (PER_USER > 0 && used >= PER_USER)
    return { allowed: false, reason: "user", limit: PER_USER };
  return { allowed: true, remaining: PER_USER > 0 ? PER_USER - used - 1 : undefined };
}

// 放行後計一次數。
export function countDemoUse(userId) {
  if (!demoLimitOn || (userId && ALLOWLIST.has(userId))) return;
  rollover();
  perUser.set(userId, (perUser.get(userId) || 0) + 1);
  globalCount++;
}

// 婉拒訊息（順便導去 fork 自己的）。
export function demoLimitMessage(gate) {
  if (gate.reason === "global") {
    return `今天 demo 太熱門，公用額度用完了 🙏 明天再來試，或自己 fork 一份無限用：\n${REPO_URL}`;
  }
  return `這是公開 demo，每天每人 ${gate.limit} 則就到上限囉 🙏\n想無限制使用？把它 fork 成你自己的助理（填自己的金鑰）：\n${REPO_URL}`;
}
