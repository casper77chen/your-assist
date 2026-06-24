// Phase 11：週回顧（每週日 21:00 台北，WEEKLY_TIME 可改）
// 本週做了什麼（行程、見了誰、coaching 場次）＋待辦現況＋下週預覽。
// 資料全部來自既有來源，這裡只做彙整。
import { calendarConfigured, listMergedEvents } from "./calendar.js";
import { contactsConfigured, getInteractions } from "./contacts.js";
import { todosConfigured, listTodos } from "./todos.js";
import { coachConfigured, listCoachNotes } from "./coach.js";

const TZ = "Asia/Taipei";
const WEEKLY_TIME = process.env.WEEKLY_TIME || "21:00";
const WEEKLY_DAY = 0; // 週日

function taipeiNow() {
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, dateStyle: "short" }).format(new Date());
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date());
  return { date, time, day: new Date(`${date}T12:00:00+08:00`).getDay() };
}

// 以台北時間算出「本週一」的日期字串（週回顧在週日晚上發，本週＝週一到今天）
function mondayOf(dateStr) {
  const d = new Date(`${dateStr}T12:00:00+08:00`);
  const diff = (d.getDay() + 6) % 7; // 週一=0
  d.setDate(d.getDate() - diff);
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00+08:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function buildWeeklyReview() {
  const { date } = taipeiNow();
  const monday = mondayOf(date);
  const sections = [`🗓 本週回顧（${monday.slice(5).replace("-", "/")}–${date.slice(5).replace("-", "/")}）`];

  // 本週行程（只計有別人參與或有標題的非全天事件數）
  if (calendarConfigured) {
    try {
      const events = await listMergedEvents({
        start: `${monday}T00:00:00+08:00`,
        end: `${date}T23:59:59+08:00`,
      });
      const meetings = events.filter((e) => !e.allDay);
      sections.push(`📅 行程 ${meetings.length} 場`);
    } catch (e) {
      sections.push(`📅 行程統計失敗（${e.message}）`);
    }
  }

  // 本週見了誰（Connectome interactions）
  if (contactsConfigured) {
    try {
      const all = await getInteractions();
      const week = all.filter((i) => i.date >= monday && i.date <= date);
      const names = [...new Set(week.flatMap((i) => (i.participants || []).map((p) => p.name)))];
      if (week.length) {
        sections.push(
          `🤝 記了 ${week.length} 筆互動，見了 ${names.length} 個人${
            names.length ? `：${names.slice(0, 10).join("、")}${names.length > 10 ? "…" : ""}` : ""
          }`
        );
      } else {
        sections.push("🤝 本週沒記任何互動（見了人記得讓我 log）");
      }
    } catch (e) {
      sections.push(`🤝 互動統計失敗（${e.message}）`);
    }
  }

  // 本週 coaching
  if (coachConfigured) {
    try {
      const notes = await listCoachNotes(200);
      const week = notes.filter((n) => n.sessionDate >= monday && n.sessionDate <= date);
      if (week.length) {
        const people = [...new Set(week.map((n) => n.person))];
        sections.push(`🎓 coaching ${week.length} 場（${people.join("、")}）`);
      }
    } catch (e) {
      sections.push(`🎓 coaching 統計失敗（${e.message}）`);
    }
  }

  // 待辦現況
  if (todosConfigured) {
    try {
      const open = await listTodos(false);
      const overdue = open.filter((t) => t.due && t.due < date);
      if (open.length) {
        sections.push(
          `☑️ 待辦剩 ${open.length} 筆${overdue.length ? `，其中 ${overdue.length} 筆已逾期：${overdue.slice(0, 3).map((t) => t.content).join("、")}${overdue.length > 3 ? "…" : ""}` : ""}`
        );
      } else {
        sections.push("☑️ 待辦清空了 💪");
      }
    } catch (e) {
      sections.push(`☑️ 待辦統計失敗（${e.message}）`);
    }
  }

  // 下週預覽
  if (calendarConfigured) {
    try {
      const nextMon = addDays(monday, 7);
      const nextSun = addDays(monday, 13);
      const events = await listMergedEvents({
        start: `${nextMon}T00:00:00+08:00`,
        end: `${nextSun}T23:59:59+08:00`,
      });
      const meetings = events.filter((e) => !e.allDay);
      const preview = meetings.slice(0, 5).map((e) => {
        const d = (e.start || "").slice(5, 10).replace("-", "/");
        return `・${d}｜${e.title}`;
      });
      sections.push(
        meetings.length
          ? `⏭ 下週 ${meetings.length} 場：\n${preview.join("\n")}${meetings.length > 5 ? "\n…" : ""}`
          : "⏭ 下週日曆目前是空的"
      );
    } catch (e) {
      sections.push(`⏭ 下週預覽失敗（${e.message}）`);
    }
  }

  return sections.join("\n\n");
}

/** 啟動週回顧排程（每週日 WEEKLY_TIME 推送）。*/
export function startWeeklyScheduler(push) {
  let lastSentDate = null;
  console.log(`🗓 週回顧排程啟動：每週日 ${WEEKLY_TIME}（台北）`);
  setInterval(async () => {
    const { date, time, day } = taipeiNow();
    if (day !== WEEKLY_DAY || time !== WEEKLY_TIME || lastSentDate === date) return;
    lastSentDate = date;
    try {
      const text = await buildWeeklyReview();
      await push(text);
      console.log(`🗓 週回顧已推送（${date}）`);
    } catch (e) {
      console.error("週回顧推送失敗：", e);
    }
  }, 60 * 1000);
}
