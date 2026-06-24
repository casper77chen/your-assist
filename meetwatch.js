// Phase 10：會議監看（會前簡報 + 會後追蹤）
// 每 5 分鐘掃一次主日曆：
// - 會議開始前 ~30 分鐘：推與會者的 Connectome 背景＋最近互動（見客戶前的小抄）
// - 會議結束後：推「要記互動嗎？」（解決開完會忘了 log 的問題）
// 只關心「有別的人類與會者」的事件；自己一個人的行程（健身、看牙）不打擾。
// 推播文字會同步進 77 的對話歷史（notePush），Casper 直接回覆就能接上文。
import { calendarConfigured, listMyEvents, dedupeEvents } from "./calendar.js";
import { contactsConfigured, getPeople, getInteractions } from "./contacts.js";

const CHECK_MS = 5 * 60 * 1000; // 掃描間隔
const LEAD_MS = 30 * 60 * 1000; // 會前提早量

const norm = (s) => (s || "").toString().toLowerCase().trim();

// 與會者（人類、非自己）。displayName 沒有就用 email 帳號當名字。
function otherHumans(event) {
  return event.attendees.filter((a) => !a.self && !a.resource && a.email);
}

function attendeeLabel(a) {
  return a.name || a.email.split("@")[0];
}

// 用 email（強）→ 名字（弱）對 Connectome 的人
async function matchPerson(attendee) {
  const people = await getPeople();
  const byEmail = people.find((p) => p.email && norm(p.email) === norm(attendee.email));
  if (byEmail) return byEmail;
  if (attendee.name) {
    const n = norm(attendee.name);
    return people.find((p) => [p.name, p.nickname, p.english_name].some((x) => x && norm(x) === n)) || null;
  }
  return null;
}

// 某人最近的互動（新到舊取 n 筆）
async function recentInteractions(person, n = 2) {
  const all = await getInteractions();
  return all
    .filter((i) =>
      (i.participants || []).some((p) => p.id === person.id || p.name === person.name)
    )
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, n);
}

function hhmm(iso) {
  if (!iso || !iso.includes("T")) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

// 會前簡報文字
export async function buildPreBrief(event) {
  const humans = otherHumans(event);
  const lines = [
    `⏰ ${hhmm(event.start)} 開會：${event.title}${event.location ? `（${event.location}）` : ""}`,
  ];
  for (const a of humans.slice(0, 4)) {
    if (!contactsConfigured) {
      lines.push(`\n👤 ${attendeeLabel(a)}`);
      continue;
    }
    try {
      const person = await matchPerson(a);
      if (!person) {
        lines.push(`\n👤 ${attendeeLabel(a)}（Connectome 沒這個人）`);
        continue;
      }
      const bits = [person.company, person.title].filter(Boolean).join("／");
      lines.push(`\n👤 ${person.name}${bits ? `（${bits}）` : ""}`);
      if (person.notes) lines.push(`・備註：${person.notes.slice(0, 80)}`);
      if (person.tags?.length) lines.push(`・標籤：${person.tags.map((t) => t.name || t).join("、")}`);
      const recent = await recentInteractions(person, 2);
      for (const i of recent) {
        lines.push(`・${i.date}：${(i.summary || "").slice(0, 60)}${i.next_steps ? `→ 下一步：${i.next_steps.slice(0, 40)}` : ""}`);
      }
    } catch (e) {
      lines.push(`\n👤 ${attendeeLabel(a)}（背景讀取失敗：${e.message}）`);
    }
  }
  if (humans.length > 4) lines.push(`\n（還有 ${humans.length - 4} 位與會者）`);
  return lines.join("\n");
}

// 會後追蹤文字
export function buildPostPrompt(event) {
  const names = otherHumans(event).map(attendeeLabel).slice(0, 4).join("、");
  return `📝 剛結束：${event.title}${names ? `（與 ${names}）` : ""}\n要記一筆互動或下一步嗎？直接回我內容就好；不用記就略過。`;
}

/**
 * 啟動會議監看。push: async (text)=>void；notePush: (text)=>void（記進對話歷史）。
 * 已處理過的事件記在 RAM Set（重啟後可能對「正在進行中」的會議重發一次，可接受）。
 */
export function startMeetingWatcher({ push, notePush, onAwaitReply }) {
  if (!calendarConfigured) {
    console.warn("⚠️ 行事曆未設定，會議監看未啟動");
    return;
  }
  const briefed = new Set(); // 已發會前簡報的 event key
  const prompted = new Set(); // 已發會後追蹤的 event key
  console.log("👀 會議監看啟動：會前 30 分簡報＋會後追蹤（每 5 分鐘掃描）");

  setInterval(async () => {
    const now = Date.now();
    try {
      // 一次抓「過去 2 小時 ~ 未來 35 分」的事件，會前會後一起判斷
      const events = dedupeEvents(await listMyEvents({
        start: new Date(now - 2 * 3600 * 1000).toISOString(),
        end: new Date(now + LEAD_MS + CHECK_MS).toISOString(),
      }));
      for (const ev of events) {
        if (ev.allDay) continue;
        if (!otherHumans(ev).length) continue; // 自己一個人的行程不打擾
        const key = `${ev.id}|${ev.start}`;
        const startMs = new Date(ev.start).getTime();
        const endMs = new Date(ev.end).getTime();

        // 會前：開始時間落在「現在 ~ +30分」內
        if (!briefed.has(key) && startMs > now && startMs <= now + LEAD_MS) {
          briefed.add(key);
          const text = await buildPreBrief(ev);
          await push(text);
          notePush(text);
          console.log(`👀 已發會前簡報：${ev.title}`);
        }

        // 會後：結束時間落在「過去一輪掃描間隔」內
        if (!prompted.has(key) && endMs <= now && endMs > now - CHECK_MS - 60 * 1000) {
          prompted.add(key);
          const text = buildPostPrompt(ev);
          await push(text);
          notePush(text);
          // 會後提示是在等 Casper 回答「要不要記互動」→ 排 1 小時沒回提醒（明確標記，繞過問號偵測）
          onAwaitReply?.(text);
          console.log(`👀 已發會後追蹤：${ev.title}`);
        }
      }
      // 防 Set 無限長大：超過 200 筆就清掉（一天的會議遠少於這數）
      if (briefed.size > 200) briefed.clear();
      if (prompted.size > 200) prompted.clear();
    } catch (e) {
      console.error("會議監看掃描失敗：", e.message);
    }
  }, CHECK_MS);
}
