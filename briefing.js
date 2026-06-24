// Phase 9：每日晨報（77 第一個「主動推播」功能）
// 每天早上（預設 07:00 台北時間）把今日行程、該跟進的人、到期待辦、
// Coach Inbox 未歸檔數整理成一則 LINE push。
// 排程是行程內 setInterval（單一 long-running pod，夠用；多實例部署才需要外部 cron）。
import { calendarConfigured, listMergedEvents } from "./calendar.js";
import { contactsConfigured, upcomingFollowups } from "./contacts.js";
import { todosConfigured, listTodos } from "./todos.js";
import { coachConfigured, listCoachNotes } from "./coach.js";
import { ownerNickname } from "./profile.js";

const TZ = "Asia/Taipei";
// 推送時間 HH:mm（台北），可用環境變數覆寫
const BRIEFING_TIME = process.env.BRIEFING_TIME || "07:00";

function taipeiNow() {
  const date = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    dateStyle: "short",
  }).format(new Date());
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
  return { date, time };
}

function hhmm(iso) {
  if (!iso || !iso.includes("T")) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

// 各區塊獨立 try/catch：一個資料源掛掉不該讓整份晨報開天窗。
export async function buildBriefing() {
  const { date } = taipeiNow();
  const weekday = WEEKDAYS[new Date(`${date}T12:00:00+08:00`).getDay()];
  const sections = [`☀️ 早安${ownerNickname() ? "，" + ownerNickname() : ""}！${date.slice(5).replace("-", "/")}（${weekday}）晨報`];

  // 今日行程
  if (calendarConfigured) {
    try {
      const events = await listMergedEvents({
        start: `${date}T00:00:00+08:00`,
        end: `${date}T23:59:59+08:00`,
      });
      if (!events.length) {
        sections.push("📅 今天日曆沒行程");
      } else {
        const lines = events.map((e) =>
          e.allDay
            ? `・全天｜${e.title}`
            : `・${hhmm(e.start)}–${hhmm(e.end)}｜${e.title}${e.location ? `（${e.location}）` : ""}`
        );
        sections.push(`📅 今日行程（${events.length}）\n${lines.join("\n")}`);
      }
    } catch (e) {
      sections.push(`📅 行程讀取失敗（${e.message}）`);
    }
  }

  // 該跟進的人（今天到期＋逾期）
  if (contactsConfigured) {
    try {
      const fu = await upcomingFollowups(0);
      if (fu.length) {
        const lines = fu
          .slice(0, 5)
          .map(
            (f) =>
              `・${f.participants.join("、") || "（沒掛人）"}｜${f.next_steps || f.summary}${
                f.follow_up_date < date ? `（${f.follow_up_date} 逾期）` : ""
              }`
          );
        sections.push(
          `🤝 該跟進（${fu.length}）\n${lines.join("\n")}${fu.length > 5 ? "\n…問我「要跟進誰」看全部" : ""}`
        );
      }
    } catch (e) {
      sections.push(`🤝 跟進清單讀取失敗（${e.message}）`);
    }
  }

  // 待辦（今天到期／逾期挑出來講，其餘給數量）
  if (todosConfigured) {
    try {
      const todos = await listTodos(false);
      const due = todos.filter((t) => t.due && t.due <= date);
      const rest = todos.length - due.length;
      if (due.length) {
        const lines = due.map(
          (t) => `・${t.content}${t.due < date ? `（${t.due} 逾期）` : ""}`
        );
        sections.push(
          `☑️ 今天到期的待辦（${due.length}）\n${lines.join("\n")}${rest > 0 ? `\n（另有 ${rest} 筆未到期）` : ""}`
        );
      } else if (todos.length) {
        sections.push(`☑️ 今天沒有到期待辦（清單上還有 ${todos.length} 筆）`);
      }
    } catch (e) {
      sections.push(`☑️ 待辦讀取失敗（${e.message}）`);
    }
  }

  // Coach Inbox 未歸檔
  if (coachConfigured) {
    try {
      const notes = await listCoachNotes(200);
      const fresh = notes.filter((n) => n.status === "new").length;
      if (fresh > 0) {
        sections.push(`🎓 Coach Inbox 有 ${fresh} 筆速記待歸檔（回電腦記得跑歸檔）`);
      }
    } catch (e) {
      sections.push(`🎓 Coach Inbox 讀取失敗（${e.message}）`);
    }
  }

  return sections.join("\n\n");
}

/**
 * 啟動晨報排程。push 是 async (text) => void（由 index.js 提供，內含收件人）。
 * 每 60 秒對一次台北時間；同一天只發一次（重啟後若再跨到 07:00 也不會重發當日）。
 */
export function startBriefingScheduler(push) {
  let lastSentDate = null;
  console.log(`⏰ 晨報排程啟動：每天 ${BRIEFING_TIME}（台北）`);
  setInterval(async () => {
    const { date, time } = taipeiNow();
    if (time !== BRIEFING_TIME || lastSentDate === date) return;
    lastSentDate = date; // 先標記，避免 buildBriefing 跑超過一分鐘導致重發
    try {
      const text = await buildBriefing();
      await push(text);
      console.log(`☀️ 晨報已推送（${date}）`);
    } catch (e) {
      console.error("晨報推送失敗：", e);
    }
  }, 60 * 1000);
}
