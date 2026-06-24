// iCal（.ics）訂閱來源：讓 77 也看得到 iCloud／Apple 行事曆。唯讀。
// 把公開 .ics feed 在指定時間窗內展開（含週期事件），轉成跟 calendar.js
// listMyEvents 一模一樣的事件形狀，好讓晨報／週回顧直接合併使用。
//
// 設定：環境變數 ICAL_FEED_URL，可逗號分隔多本。webcal:// 會自動轉 https://。
// iCloud 取得方式：行事曆 App → 該行事曆設「公開行事曆」→ 複製連結。
import IcalExpander from "ical-expander";

const FEEDS = (process.env.ICAL_FEED_URL || "")
  .split(",")
  .map((s) => s.trim().replace(/^webcal:\/\//i, "https://"))
  .filter(Boolean);

export const icalConfigured = FEEDS.length > 0;

// 對齊 calendar.js listMyEvents 的回傳形狀。
// 公開 .ics 通常沒有完整與會者資料，attendees 給空陣列。
function toEvent({ uid, summary, location, startTime, endTime, recurrenceId }) {
  return {
    id: `ical:${uid}${recurrenceId ? `|${recurrenceId.toString()}` : ""}`,
    title: summary || "（無標題）",
    start: startTime.toJSDate().toISOString(),
    end: endTime.toJSDate().toISOString(),
    location: location || undefined,
    allDay: Boolean(startTime.isDate), // ICAL.Time：純日期 = 全天
    attendees: [],
  };
}

/**
 * 列出所有 iCal feed 在某段時間的行程。單一 feed 掛掉只記 log，不影響其餘。
 * @param {{start:string,end:string}} q ISO 8601
 * @returns {Promise<Array<{id:string,title:string,start:string,end:string,location?:string,allDay:boolean,attendees:[]}>>}
 */
export async function listIcalEvents({ start, end }) {
  if (!icalConfigured) return [];
  const after = new Date(start);
  const before = new Date(end);
  const out = [];
  for (const url of FEEDS) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ics = await res.text();
      const { events, occurrences } = new IcalExpander({ ics, maxIterations: 1000 }).between(after, before);
      for (const e of events) {
        out.push(toEvent({ uid: e.uid, summary: e.summary, location: e.location, startTime: e.startDate, endTime: e.endDate }));
      }
      for (const o of occurrences) {
        out.push(toEvent({ uid: o.item.uid, summary: o.item.summary, location: o.item.location, startTime: o.startDate, endTime: o.endDate, recurrenceId: o.recurrenceId }));
      }
    } catch (err) {
      console.error(`iCal 讀取失敗（${url}）：`, err.message);
    }
  }
  return out;
}
