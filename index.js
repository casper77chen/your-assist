import dns from "node:dns";
// 強制 DNS 先回 IPv4：Zeabur Tokyo 節點對 Google（oauth2.googleapis.com）的 IPv6
// 出口路由曾整夜壞掉、連線被 mid-response 切斷（ERR_STREAM_PREMATURE_CLOSE），
// 導致所有 Google API（行程／待辦／Coach／記憶）刷 token 失敗。走 IPv4 可避開。
dns.setDefaultResultOrder("ipv4first");

import express from "express";
import { messagingApi, middleware } from "@line/bot-sdk";
import {
  reply as ask77,
  replyImage as ask77Image,
  replyDocument as ask77Document,
  notePush,
  classifyAnsweredQuestions,
} from "./assistant.js";
import { recordTranscript } from "./transcript.js";
import { transcribeConfigured, transcribe } from "./transcribe.js";
import {
  getAuthUrl,
  exchangeCode,
  discoverRooms,
  oauthClientConfigured,
  calendarConfigured,
} from "./calendar.js";
import {
  createMemorySpreadsheet,
  getMemories,
  memoryConfigured,
} from "./memory.js";
import {
  connectomeConfigured,
  pingConnectome,
  findDuplicateGroups,
  mergePersonInto,
  deletePerson,
  getInteractions,
} from "./connectome.js";
import { buildBriefing, startBriefingScheduler } from "./briefing.js";
import { startMeetingWatcher } from "./meetwatch.js";
import { buildWeeklyReview, startWeeklyScheduler } from "./weekly.js";
import { loadSettings, settingsWritable, resetAll } from "./settings.js";
import { assistantName, ownerName } from "./profile.js";
import { contactsConfigured } from "./contacts.js";
import { todosConfigured } from "./todos.js";
import { mywikiConfigured } from "./mywiki.js";
import { knowledgeConfigured } from "./knowledge.js";
import { checkDemoLimit, countDemoUse, demoLimitMessage, demoLimitOn } from "./demo-limit.js";
import { renderSettingsPage, applySettings, renderGuidePage, renderLandingPage } from "./settings-page.js";

const { MessagingApiClient } = messagingApi;

// ── 環境變數 ──────────────────────────────────────────────
const channelSecret = process.env.LINE_CHANNEL_SECRET;
const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const port = process.env.PORT || 3000;
const setupKey = process.env.SETUP_KEY; // 保護一次性 OAuth/setup 路由
// 晨報收件人（主人的 LINE userId）。沒設時 /brief 會顯示最近傳訊者的 id 供複製。
const briefingUserId =
  process.env.OWNER_LINE_USER_ID || process.env.CASPER_LINE_USER_ID;

// 最後一個傳訊息來的 userId（單人使用＝Casper 本人；給 /brief 顯示用）
let lastSeenUserId = null;

if (!channelSecret || !channelAccessToken) {
  console.error("❌ 缺少 LINE_CHANNEL_SECRET 或 LINE_CHANNEL_ACCESS_TOKEN");
  process.exit(1);
}

// ── LINE client ──────────────────────────────────────────
const client = new MessagingApiClient({ channelAccessToken });

const app = express();

// 根網址＝公開落地頁（WCA 風格 hero + 入口）
app.get("/", (_req, res) => res.type("html").send(renderLandingPage()));
// 純文字健康檢查（給 uptime 監控用，維持原本的 alive 字串）
app.get("/healthz", (_req, res) => res.send(`${assistantName()} is alive 🤖`));

// 77 能力一覽（手機書籤用；純資訊、不需 key）：/help
app.get("/help", (_req, res) => {
  const name = assistantName();
  // 依「目前連上哪些能力」動態長出清單——沒接的能力不會出現。
  const sections = [
    ["對話", ["自然聊天、記得上下文", "切換模型：/model ・ 重設對話：/reset"]],
  ];
  if (calendarConfigured)
    sections.push(["行程 / 日曆", [
      "查自己的行程（今天 / 這週 / 明天，Google＋iCal 合併）",
      "訂會議室、查會議室空不空、查排了什麼",
      "建立行程、邀請與會者",
    ]]);
  if (contactsConfigured)
    sections.push(["人脈", [
      "找人、新增 / 更新聯絡人（自動防重複建檔）",
      "記互動 / 會議、看該跟進的人、建關係、貼標籤",
      "待約清單：/meet 或說「看待約」",
      "名片拍照辨識 → 確認後建檔",
    ]]);
  if (memoryConfigured)
    sections.push(["長期記憶", ["記住你的偏好與習慣，越用越懂你"]]);
  if (todosConfigured)
    sections.push(["待辦", ["新增 / 列出 / 完成待辦（可帶到期日）"]]);
  if (knowledgeConfigured)
    sections.push(["決策日誌 / 知識庫", ["記下決策＋為什麼，事後可問知識庫"]]);
  const multimodal = ["PDF 摘要（合約抓錢 / 期限 / 條款）", "白板 / 簡報照片整理重點"];
  if (transcribeConfigured) multimodal.push("語音訊息自動轉文字");
  sections.push(["多模態輸入", multimodal]);
  if (calendarConfigured || contactsConfigured)
    sections.push(["主動推播", [
      "每日晨報、週回顧",
      "會議監看：會前推與會者背景、會後問要不要記互動",
    ]]);

  // 「可擴充能力」：尚未連上的能力，列出來告訴使用者「連上就開」＋怎麼接。
  // 這是框架的「連接器」故事——對 demo 也剛好用來展示知識庫等還沒接的能力。
  const extras = [];
  if (!calendarConfigured) extras.push("行程 / 日曆 / 會議室 → 連 Google");
  if (!contactsConfigured) extras.push("人脈管理（找人 / 互動 / 跟進）→ 連 Connectome");
  if (!memoryConfigured) extras.push("長期記憶 / 待辦 → 連 Google 試算表");
  if (!knowledgeConfigured) extras.push("決策日誌 / 知識庫 → 串接 MyWiki 或 Obsidian");
  if (!transcribeConfigured) extras.push("語音訊息轉文字 → 連 OpenAI（Whisper）");
  if (extras.length) sections.push(["可擴充能力（連上就開）", extras]);

  const body = sections
    .map(
      ([title, items]) =>
        `<section><p class="eyebrow">${title}</p><ul>${items
          .map((i) => `<li>${i}</li>`)
          .join("")}</ul></section>`
    )
    .join("");
  res.type("html").send(`<!doctype html><html lang="zh-Hant"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name}・能力</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&family=Noto+Serif+TC:wght@700&family=Playfair+Display&display=swap" rel="stylesheet">
<style>
:root{color-scheme:dark}
body{font-family:"Noto Sans TC",-apple-system,system-ui,sans-serif;font-size:16px;line-height:1.7;
 margin:0 auto;max-width:680px;padding:0 20px 56px;color:#E5E7EB;
 background:radial-gradient(ellipse at top,rgba(240,214,149,.10) 0%,rgba(9,24,43,0) 55%),
 repeating-linear-gradient(45deg,transparent 0,transparent 2px,rgba(200,163,89,.025) 2px,rgba(200,163,89,.025) 4px),#09182B;
 background-attachment:fixed}
h1{font-family:"Noto Serif TC",serif;font-weight:700;font-size:28px;color:#fff;margin:48px 0 4px}
.sub{color:#94A3B8;font-size:13px;margin:0 0 22px}
section{border:1px solid rgba(200,163,89,.28);border-radius:8px;padding:14px 18px;margin:0 0 12px;background:rgba(9,24,43,.55)}
.eyebrow{font-family:"Playfair Display",serif;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#C8A359;margin:0 0 8px}
ul{margin:0;padding-left:18px}li{margin:4px 0;color:#CBD5E1}
.foot{color:#94A3B8;font-size:12px;margin-top:18px;text-align:center}
</style></head><body>
<h1>${name}・能力一覽</h1>
<p class="sub">你的 LINE AI 助理現在會做的事，以及還能連上哪些能力</p>
${body}
<p class="foot">要改名字、口吻、規則或連結更多系統 → 開 /settings</p>
</body></html>`);
});

// 使用說明（onboarding 介紹頁，公開、不需 key；會把 key 帶回設定頁連結）：/guide
app.get("/guide", (req, res) => {
  res.type("html").send(renderGuidePage({ setupKey: req.query.key }));
});

// ── 設定頁（把助理變成你的）：/settings?key=SETUP_KEY ─────────
// GET 渲染表單；POST 存覆寫進 settings 試算表；POST /settings/reset 全域還原。
app.get("/settings", (req, res) => {
  if (!requireSetupKey(req, res)) return;
  res.type("html").send(renderSettingsPage({ setupKey, saved: false }));
});

app.post(
  "/settings",
  express.urlencoded({ extended: true, limit: "2mb" }),
  async (req, res) => {
    if (!requireSetupKey(req, res)) return;
    if (!settingsWritable) {
      return res
        .status(400)
        .send("未接 Google Sheets（缺 MEMORY_SPREADSHEET_ID），設定無法儲存。");
    }
    try {
      await applySettings(req.body || {});
      res.type("html").send(renderSettingsPage({ setupKey, saved: true }));
    } catch (e) {
      console.error("settings 儲存失敗：", e);
      res.status(500).send("儲存失敗：" + e.message);
    }
  }
);

app.post(
  "/settings/reset",
  express.urlencoded({ extended: false }),
  async (req, res) => {
    if (!requireSetupKey(req, res)) return;
    if (!settingsWritable) return res.status(400).send("設定為唯讀，無法還原。");
    try {
      await resetAll();
      res.redirect("/settings?key=" + encodeURIComponent(setupKey));
    } catch (e) {
      console.error("settings 還原失敗：", e);
      res.status(500).send("還原失敗：" + e.message);
    }
  }
);

// ── 一次性 OAuth 授權流程（設定完成後可停用）─────────────────
function requireSetupKey(req, res) {
  if (!setupKey) {
    res.status(400).send("請先在 Zeabur 設定 SETUP_KEY 環境變數");
    return false;
  }
  if (req.query.key !== setupKey && req.query.state !== setupKey) {
    res.status(403).send("key 不正確");
    return false;
  }
  return true;
}

// 開始授權：瀏覽器打開 /oauth/connect?key=你的SETUP_KEY
app.get("/oauth/connect", (req, res) => {
  if (!requireSetupKey(req, res)) return;
  if (!oauthClientConfigured) {
    return res
      .status(400)
      .send("請先設定 GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET");
  }
  res.redirect(getAuthUrl(setupKey)); // 用 state 帶回 key
});

// Google 導回這裡，換 refresh token 顯示出來
app.get("/oauth/callback", async (req, res) => {
  if (!requireSetupKey(req, res)) return;
  try {
    const tokens = await exchangeCode(req.query.code);
    if (!tokens.refresh_token) {
      return res.send(
        "沒拿到 refresh token。請到 Google 帳號 → 安全性 → 第三方存取，移除本 app 後再試一次 /oauth/connect。"
      );
    }
    res.type("html").send(
      `<pre style="font-size:15px;line-height:1.6;white-space:pre-wrap">授權成功 ✅

請把下面這串設成 Zeabur 環境變數 GOOGLE_REFRESH_TOKEN，存檔後 Restart：

${tokens.refresh_token}

設好就完成了，這個頁面之後不用再開。</pre>`
    );
  } catch (e) {
    console.error("OAuth callback 失敗：", e);
    res.status(500).send("交換 token 失敗：" + e.message);
  }
});

// 挖出曾用過的會議室資源：/setup/rooms?key=你的SETUP_KEY
app.get("/setup/rooms", async (req, res) => {
  if (!requireSetupKey(req, res)) return;
  try {
    const rooms = await discoverRooms();
    res.type("html").send(
      `<pre style="font-size:15px;line-height:1.6;white-space:pre-wrap">找到 ${rooms.length} 間用過的會議室：

${rooms.map((r) => `${r.name}\n  ${r.email}`).join("\n\n") || "（沒找到，先在日曆建一個有加會議室的活動再試）"}</pre>`
    );
  } catch (e) {
    console.error("discoverRooms 失敗：", e);
    res.status(500).send("查詢失敗：" + e.message);
  }
});

// 建立／檢視長期記憶庫：/setup/memory?key=你的SETUP_KEY
app.get("/setup/memory", async (req, res) => {
  if (!requireSetupKey(req, res)) return;
  try {
    if (memoryConfigured) {
      const mems = await getMemories();
      return res.type("html").send(
        `<pre style="font-size:15px;line-height:1.6;white-space:pre-wrap">記憶庫已設定好 ✅ 目前有 ${mems.length} 則記憶。

（要重建請清掉環境變數 MEMORY_SPREADSHEET_ID 後再開此頁。）</pre>`
      );
    }
    const id = await createMemorySpreadsheet();
    res.type("html").send(
      `<pre style="font-size:15px;line-height:1.6;white-space:pre-wrap">記憶庫建立成功 ✅

請把下面這串設成 Zeabur 環境變數 MEMORY_SPREADSHEET_ID，存檔後 Restart：

${id}

試算表會出現在你的 Google Drive，名稱「77 記憶庫」，你隨時能打開看／改。</pre>`
    );
  } catch (e) {
    console.error("setup/memory 失敗：", e);
    res
      .status(500)
      .send(
        "建立記憶庫失敗：" +
          e.message +
          "（若提示權限/scope 不足，請先重跑 /oauth/connect 重新授權）"
      );
  }
});

// 驗證 Connectome 連線：/setup/connectome?key=你的SETUP_KEY
app.get("/setup/connectome", async (req, res) => {
  if (!requireSetupKey(req, res)) return;
  if (!connectomeConfigured) {
    return res
      .status(400)
      .send("請先設定環境變數 CONNECTOME_EMAIL / CONNECTOME_PASSWORD");
  }
  try {
    const { user, peopleCount } = await pingConnectome();
    res.type("html").send(
      `<pre style="font-size:15px;line-height:1.6;white-space:pre-wrap">Connectome 連線成功 ✅

登入身分：${user?.name || user?.email || "（未知）"}
目前聯絡人：${peopleCount} 位

77 已經可以幫你管理人脈了。</pre>`
    );
  } catch (e) {
    console.error("setup/connectome 失敗：", e);
    res
      .status(500)
      .send(
        "Connectome 連線失敗：" +
          e.message +
          "（請確認帳密正確、且帳號狀態為 active）"
      );
  }
});

// ── 清理舊重複聯絡人：/setup/dedupe?key=你的SETUP_KEY ───────────
// GET：掃出疑似重複的群組，逐組讓你挑「主檔」後按合併。
// POST：把其餘檔的資料併進主檔（空欄補、notes 追加），並自動刪掉「完全沒有
//       互動紀錄」的重複檔；有互動紀錄的保留並列出來請你到 con 手動處理。
function dedupeEscape(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

// 算每個 person 出現在幾筆互動裡（用來判斷能否安全刪除）。
async function interactionCountByPerson() {
  const interactions = await getInteractions();
  const count = new Map();
  for (const it of interactions) {
    for (const part of it.participants || []) {
      const pid = part?.id ?? part?.person_id;
      if (pid != null) count.set(pid, (count.get(pid) || 0) + 1);
    }
  }
  return count; // size===0 代表互動資料抓不到 participant id（此時不自動刪）
}

app.get("/setup/dedupe", async (req, res) => {
  if (!requireSetupKey(req, res)) return;
  if (!connectomeConfigured) {
    return res
      .status(400)
      .send("請先設定環境變數 CONNECTOME_EMAIL / CONNECTOME_PASSWORD");
  }
  try {
    const [groups, counts] = await Promise.all([
      findDuplicateGroups(),
      interactionCountByPerson(),
    ]);
    const key = dedupeEscape(setupKey);
    const head = `<meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{font:15px/1.6 -apple-system,sans-serif;margin:16px;color:#222}
.g{border:1px solid #ddd;border-radius:10px;padding:12px;margin:0 0 16px}
.m{padding:8px 0;border-top:1px dashed #eee}
.m:first-child{border-top:0}
.hd{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}
.score{background:#eef4ff;color:#06c;border-radius:6px;padding:1px 8px;font-size:13px;font-weight:600}
.tbl{margin:6px 0 0;font-size:13px}
.tbl div{padding:1px 0}
.k{display:inline-block;width:5.5em;color:#999}
.on{color:#222}
.off{color:#ccc}
button{font-size:15px;padding:8px 16px;border:0;border-radius:8px;background:#06c;color:#fff}
small{color:#999}</style>`;
    if (!groups.length) {
      return res
        .type("html")
        .send(`${head}<h2>人脈去重</h2><p>沒有發現重複的聯絡人 🎉</p>`);
    }
    // 攤開比較用的欄位（用來算「完整度」與並排顯示）
    const DISP = [
      ["company", "公司"], ["title", "職稱"], ["phone", "電話"], ["email", "email"],
      ["birthday", "生日"], ["city", "城市"], ["first_met_place", "初識場合"], ["notes", "備註"],
    ];
    const filledCount = (p) => DISP.filter(([k]) => p[k]).length;
    const blocks = groups
      .map((g) => {
        // 建議主檔：先看完整度，再看互動數，平手取 id 最小（最早建立）
        const sorted = [...g].sort(
          (a, b) =>
            filledCount(b) - filledCount(a) ||
            (counts.get(b.id) || 0) - (counts.get(a.id) || 0) ||
            a.id - b.id
        );
        const suggested = sorted[0].id;
        const members = g.map((p) => p.id).join(",");
        const rows = sorted
          .map((p) => {
            const n = counts.get(p.id) || 0;
            const fc = filledCount(p);
            const table = DISP.map(([k, label]) => {
              const v = p[k];
              const shown =
                k === "notes" && v
                  ? dedupeEscape(String(v).replace(/\s+/g, " ").slice(0, 40))
                  : dedupeEscape(v);
              return `<div class="${v ? "on" : "off"}"><span class="k">${label}</span>${
                v ? shown : "—"
              }</div>`;
            }).join("");
            return `<label class="m">
<div class="hd"><input type="radio" name="primary" value="${p.id}"${
              p.id === suggested ? " checked" : ""
            }> <b>${dedupeEscape(p.name)}</b> <small>#${p.id}</small>
<span class="score">完整度 ${fc}/${DISP.length}</span>
<span class="score">互動 ${n} 筆${n === 0 ? "・可自動刪" : "・保留"}</span></div>
<div class="tbl">${table}</div></label>`;
          })
          .join("");
        return `<form class="g" method="POST" action="/setup/dedupe?key=${key}">
<div>選一個要保留的主檔（其餘併進去；已幫你預選完整度最高的那筆）：</div>${rows}
<input type="hidden" name="members" value="${members}">
<p><button type="submit">合併這組</button></p></form>`;
      })
      .join("");
    res
      .type("html")
      .send(
        `${head}<h2>人脈去重</h2><p>找到 <b>${groups.length}</b> 組疑似重複。每筆都標了<b>完整度</b>（填了幾個欄位）和互動筆數，已預選完整度最高的當主檔。</p>
<p><small>合併規則：其他筆的資料只拿來<b>補主檔的空欄</b>、備註追加，<b>不會覆蓋主檔已有的值</b>，所以選哪筆當主檔資料都不會少；之後沒有互動紀錄的重複檔會自動刪除。</small></p>${blocks}
<p><small>判準：電話相同／email 相同／同名同公司。看起來不該併的就別按。</small></p>`
      );
  } catch (e) {
    console.error("setup/dedupe GET 失敗：", e);
    res.status(500).send("掃描失敗：" + e.message);
  }
});

app.post(
  "/setup/dedupe",
  express.urlencoded({ extended: false }),
  async (req, res) => {
    if (!requireSetupKey(req, res)) return;
    if (!connectomeConfigured) {
      return res.status(400).send("Connectome 未設定");
    }
    try {
      const primary = Number(req.body.primary);
      const members = String(req.body.members || "")
        .split(",")
        .map(Number)
        .filter((n) => Number.isFinite(n));
      const sources = members.filter((id) => id !== primary);
      if (!primary || !sources.length) {
        return res.status(400).send("參數不對（缺 primary 或 sources）");
      }
      const { patch } = await mergePersonInto(primary, sources);
      const counts = await interactionCountByPerson();
      const countsKnown = counts.size > 0;
      const deleted = [];
      const kept = [];
      for (const id of sources) {
        const n = counts.get(id) || 0;
        // 只刪「確定沒有互動紀錄」的；抓不到互動資料時一律保留，避免誤刪歷史
        if (countsKnown && n === 0) {
          try {
            await deletePerson(id);
            deleted.push(id);
          } catch (e) {
            kept.push({ id, reason: "刪除失敗：" + e.message });
          }
        } else {
          kept.push({
            id,
            reason: countsKnown ? `有 ${n} 筆互動，保留請手動處理` : "互動數未知，保留",
          });
        }
      }
      const key = dedupeEscape(setupKey);
      const patchStr =
        Object.keys(patch).length
          ? Object.entries(patch)
              .map(([k, v]) => `${k}=${dedupeEscape(v)}`)
              .join("、")
          : "（主檔已是最完整，無欄位變更）";
      res.type("html").send(
        `<meta name="viewport" content="width=device-width,initial-scale=1"><div style="font:15px/1.7 -apple-system,sans-serif;margin:16px">
<h2>合併完成</h2>
<p>主檔 #${primary} 補上的資料：${patchStr}</p>
<p>已自動刪除的重複檔：${deleted.length ? deleted.map((i) => "#" + i).join("、") : "（無）"}</p>
${
  kept.length
    ? `<p>保留待你手動處理：<br>${kept
        .map((k) => `#${k.id} — ${dedupeEscape(k.reason)}`)
        .join("<br>")}</p><p><small>這些檔有互動紀錄，自動刪會弄丟歷史。請到 Connectome App 把互動轉到主檔 #${primary} 後再刪。</small></p>`
    : ""
}
<p><a href="/setup/dedupe?key=${key}">← 回去處理其他組</a></p></div>`
      );
    } catch (e) {
      console.error("setup/dedupe POST 失敗：", e);
      res.status(500).send("合併失敗：" + e.message);
    }
  }
);

// 晨報：GET /brief?key=SETUP_KEY → 立刻組一份並推到 LINE（測試／補發用）
app.get("/brief", async (req, res) => {
  if (!requireSetupKey(req, res)) return;
  const to = briefingUserId || lastSeenUserId;
  if (!to) {
    return res
      .status(400)
      .send(
        "還不知道要推給誰：請先設環境變數 OWNER_LINE_USER_ID。\n（先用 LINE 傳任一句話給助理，再重開此頁就會顯示你的 userId。）"
      );
  }
  try {
    const text = await buildBriefing();
    await client.pushMessage({ to, messages: [{ type: "text", text }] });
    res.type("html").send(
      `<pre style="font-size:15px;line-height:1.6;white-space:pre-wrap">已推送晨報 ✅（收件人 ${to}${
        briefingUserId ? "" : "，目前用的是最近傳訊者；請把這個 id 設成環境變數 OWNER_LINE_USER_ID"
      }）

──── 內容預覽 ────
${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`
    );
  } catch (e) {
    console.error("brief 失敗：", e);
    res.status(500).send("晨報推送失敗：" + e.message);
  }
});

// 週回顧：GET /weekly?key=SETUP_KEY → 立刻組一份並推到 LINE（測試／補發用）
app.get("/weekly", async (req, res) => {
  if (!requireSetupKey(req, res)) return;
  const to = briefingUserId || lastSeenUserId;
  if (!to) return res.status(400).send("還不知道要推給誰（缺 OWNER_LINE_USER_ID）");
  try {
    const text = await buildWeeklyReview();
    await client.pushMessage({ to, messages: [{ type: "text", text }] });
    res.type("html").send(
      `<pre style="font-size:15px;line-height:1.6;white-space:pre-wrap">已推送週回顧 ✅

${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`
    );
  } catch (e) {
    console.error("weekly 失敗：", e);
    res.status(500).send("週回顧推送失敗：" + e.message);
  }
});

// MyWiki 通知：inbox pipeline 跑完後 POST 過來——知識衝突（conflicts）＋
// Connectome 對不到的人物（connectomePeople，Phase M4）。
// 驗證共用 MYWIKI_API_KEY（兩邊本來就同值）。
app.post("/notify/mywiki", express.json({ limit: "200kb" }), async (req, res) => {
  const expected = process.env.MYWIKI_API_KEY;
  const got = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!expected || got !== expected) return res.status(401).json({ error: "key 不正確" });
  const to = briefingUserId || lastSeenUserId;
  if (!to) return res.status(503).json({ error: "缺 OWNER_LINE_USER_ID" });
  try {
    const { title, conflicts, connectomePeople } = req.body || {};
    const texts = [];
    if (Array.isArray(conflicts) && conflicts.length) {
      const lines = conflicts
        .slice(0, 3)
        .map((c) => `・舊：${(c.oldClaim || "").slice(0, 80)}\n　新：${(c.newClaim || "").slice(0, 80)}`);
      texts.push(
        `⚠️ 知識衝突：你剛存的「${title || "（無標題）"}」跟既有知識對不上：\n\n${lines.join("\n")}` +
          `${conflicts.length > 3 ? `\n（共 ${conflicts.length} 筆）` : ""}\n\n到 MyWiki 首頁的衝突橫幅選「更新」或「保留」。`
      );
    }
    if (Array.isArray(connectomePeople) && connectomePeople.length) {
      const base = (process.env.MYWIKI_BASE_URL || "https://casper-mywiki.zeabur.app").replace(/\/$/, "");
      const lines = connectomePeople.slice(0, 5).map((p) => {
        const why =
          p.status === "ambiguous"
            ? `con 有多位同名${p.candidates?.length ? `（${p.candidates.slice(0, 3).join("、")}）` : ""}，要指定`
            : "con 裡沒有這個人";
        return `・${p.name}——${why}\n　${base}/entity/${p.entityId}`;
      });
      texts.push(
        `🤝 人脈待連結：「${title || "（無標題）"}」提到 ${connectomePeople.length} 位還沒連上 con 的人：\n\n${lines.join("\n")}` +
          `${connectomePeople.length > 5 ? `\n（共 ${connectomePeople.length} 位）` : ""}` +
          `\n\n開連結可搜尋指定或一鍵建到 con；也可以直接跟我說「幫我把○○建進 con」。`
      );
    }
    if (!texts.length) return res.json({ ok: true, pushed: false });
    await client.pushMessage({ to, messages: texts.map((text) => ({ type: "text", text })) });
    texts.forEach((text) => notePush(to, text));
    res.json({ ok: true, pushed: true });
  } catch (e) {
    console.error("notify/mywiki 失敗：", e);
    res.status(500).json({ error: e.message });
  }
});

// Dashboard 通知：Casper_dashboard 巡檢各站後 POST 過來，三種情況（可同時帶）：
//   - increases：待審核（pending）數量上升
//   - offline：站點從上線轉為離線（健康檢查失敗 / 非 2xx）
//   - recovered：站點從離線恢復上線
// 驗證共用 DASHBOARD_API_KEY（兩邊同值，預設 casper-dash-2025）。
// body: {
//   increases: [{ name, url, adminUrl, count, prev, delta }],
//   offline:   [{ name, url, statusCode, error }],
//   recovered: [{ name, url }],
//   dashboardUrl
// }
app.post("/notify/dashboard", express.json({ limit: "100kb" }), async (req, res) => {
  const expected = process.env.DASHBOARD_API_KEY || "casper-dash-2025";
  const got = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (got !== expected) return res.status(401).json({ error: "key 不正確" });
  const to = briefingUserId || lastSeenUserId;
  if (!to) return res.status(503).json({ error: "缺 OWNER_LINE_USER_ID" });
  try {
    const { increases, offline, recovered, dashboardUrl } = req.body || {};
    const dash = (dashboardUrl || "https://dashboard.casper77chen.com").replace(/\/$/, "");
    const texts = [];

    if (Array.isArray(increases) && increases.length) {
      const lines = increases.slice(0, 10).map((s) => {
        const link = s.adminUrl || s.url;
        const delta = s.delta != null ? ` +${s.delta}` : "";
        const total = s.count != null ? `（共 ${s.count} 筆）` : "";
        return `・${s.name}${delta}${total}\n　${link}`;
      });
      texts.push(
        `🔔 有新的待審核（Pending）：\n\n${lines.join("\n")}` +
          `${increases.length > 10 ? `\n（共 ${increases.length} 站有新增）` : ""}` +
          `\n\n👉 Dashboard：${dash}`
      );
    }

    if (Array.isArray(offline) && offline.length) {
      const lines = offline.slice(0, 10).map((s) => {
        const reason = s.statusCode ? `HTTP ${s.statusCode}` : s.error || "連線失敗";
        return `・${s.name}（${reason}）\n　${s.url}`;
      });
      texts.push(
        `🔴 網站離線：\n\n${lines.join("\n")}` +
          `${offline.length > 10 ? `\n（共 ${offline.length} 站）` : ""}` +
          `\n\n👉 Dashboard：${dash}`
      );
    }

    if (Array.isArray(recovered) && recovered.length) {
      const lines = recovered.slice(0, 10).map((s) => `・${s.name}\n　${s.url}`);
      texts.push(
        `🟢 已恢復上線：\n\n${lines.join("\n")}` +
          `${recovered.length > 10 ? `\n（共 ${recovered.length} 站）` : ""}`
      );
    }

    if (!texts.length) return res.json({ ok: true, pushed: false });
    await client.pushMessage({ to, messages: texts.map((text) => ({ type: "text", text })) });
    texts.forEach((text) => notePush(to, text));
    res.json({ ok: true, pushed: true });
  } catch (e) {
    console.error("notify/dashboard 失敗：", e);
    res.status(500).json({ error: e.message });
  }
});

// LINE webhook —— middleware 會自動驗證簽章
app.post("/webhook", middleware({ channelSecret }), async (req, res) => {
  // 先回 200，避免 LINE 重送（實際處理非同步進行）
  res.status(200).end();

  const events = req.body.events ?? [];
  await Promise.all(events.map(handleEvent));
});

// 從 LINE 下載訊息附件（圖片）內容，回傳 base64 與 media type
async function downloadLineContent(messageId) {
  const res = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    { headers: { Authorization: `Bearer ${channelAccessToken}` } }
  );
  if (!res.ok) {
    throw new Error(`下載 LINE 圖片失敗：HTTP ${res.status}`);
  }
  const mediaType = (res.headers.get("content-type") || "image/jpeg").split(
    ";"
  )[0];
  const base64 = Buffer.from(await res.arrayBuffer()).toString("base64");
  return { base64, mediaType };
}

// Claude 單張圖片上限 5MB（base64 後計），留點餘裕
const MAX_IMAGE_BASE64_CHARS = 4.5 * 1024 * 1024;
// Claude PDF 上限 32MB / 100 頁；LINE 下載 + base64 膨脹後抓 20MB 保險
const MAX_PDF_BASE64_CHARS = 20 * 1024 * 1024;

const SUPPORTED_TYPES = new Set(["text", "image", "file", "audio"]);

// ── 事件處理 ──────────────────────────────────────────────
// ── 「77 問了問題、等你回答」提醒 ───────────────────────────
// 77 每則以問號收尾的回覆＝在等 Casper 回答，各自排一個 1 小時鬧鐘。
// 重點：只有「真的回答到那題」才會把該題的鬧鐘取消（由 classifyAnsweredQuestions 判斷）；
// 換話題、另外講別的事，原本沒答的題目鬧鐘會持續。一題只提醒一次。
const QUESTION_NUDGE_MS = 60 * 60 * 1000; // 1 小時
const MAX_PENDING = 5; // 每人最多同時追蹤幾題（超過丟最舊）
const pendingQuestions = new Map(); // userId -> Array<{ text, timer }>
// 去掉結尾的空白／表情／裝飾後，看是不是以問號收尾
const TRAIL_DECOR =
  /[\s\u{200D}\u{FE0F}\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}"'」』）)]+$/u;
function isAwaitingAnswer(text) {
  if (!text) return false;
  return /[?？]$/.test(String(text).replace(TRAIL_DECOR, ""));
}

async function fireQuestionNudge(userId, entry) {
  const list = pendingQuestions.get(userId);
  if (list) {
    const i = list.indexOf(entry);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) pendingQuestions.delete(userId);
  }
  const base = entry.text.replace(/\s+/g, " ").trim();
  const snippet = base.length > 40 ? `${base.slice(0, 40)}…` : base;
  const text = `?\n（還在等你回：${snippet}）`;
  try {
    await client.pushMessage({ to: userId, messages: [{ type: "text", text }] });
    notePush(userId, text);
  } catch (err) {
    console.error("問題提醒 push 失敗：", err);
  }
}

// 77 這則回覆若在問問題、等回答 → 新增一個 1 小時鬧鐘。
// force=true：明確標記「這則在等回答」，跳過「結尾是問號」偵測（給主動推播如會後提示用，
// 因為那種文字問號在句中、結尾常是說明句）。
function addQuestionNudge(userId, replyText, force = false) {
  if (!userId || userId === "anonymous") return; // 沒有真實 userId 沒辦法 push
  if (!force && !isAwaitingAnswer(replyText)) return;
  const list = pendingQuestions.get(userId) || [];
  const entry = { text: String(replyText), timer: null };
  entry.timer = setTimeout(() => fireQuestionNudge(userId, entry), QUESTION_NUDGE_MS);
  if (typeof entry.timer.unref === "function") entry.timer.unref();
  list.push(entry);
  while (list.length > MAX_PENDING) clearTimeout(list.shift().timer); // 丟最舊
  pendingQuestions.set(userId, list);
}

// Casper 這則訊息回答到了某些題目 → 取消那些題的鬧鐘（換話題不會清掉沒答的）。
// 用 entry 參照比對（不是索引），避免 await 期間清單變動造成錯殺。
function clearNudgeEntries(userId, entries) {
  if (!entries.length) return;
  const list = pendingQuestions.get(userId);
  if (!list) return;
  const drop = new Set(entries);
  const remaining = list.filter((entry) => {
    if (drop.has(entry)) {
      clearTimeout(entry.timer);
      return false;
    }
    return true;
  });
  if (remaining.length) pendingQuestions.set(userId, remaining);
  else pendingQuestions.delete(userId);
}

// Casper 回「later」→ 把所有待回提醒延後：各自重排一個 1 小時鬧鐘。
function snoozeNudges(userId) {
  const list = pendingQuestions.get(userId);
  if (!list || !list.length) return 0;
  for (const entry of list) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => fireQuestionNudge(userId, entry), QUESTION_NUDGE_MS);
    if (typeof entry.timer.unref === "function") entry.timer.unref();
  }
  return list.length;
}

// 回覆 Casper：先用 replyMessage（免費額度），失敗（如 replyToken 過期／工具跑太久）
// 就改用 pushMessage 補送，避免「77 完全沒回應」。
async function sendReply(event, userId, text) {
  try {
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: "text", text }],
    });
  } catch (err) {
    console.error("LINE replyMessage 失敗，改用 push：", err?.message || err);
    if (userId && userId !== "anonymous") {
      try {
        await client.pushMessage({ to: userId, messages: [{ type: "text", text }] });
      } catch (err2) {
        console.error("push 補送也失敗：", err2?.message || err2);
      }
    }
  }
}

async function handleEvent(event) {
  // 文字、圖片（名片/白板）、PDF 檔案、語音都交給 77（Claude）回覆
  if (event.type !== "message" || !SUPPORTED_TYPES.has(event.message.type))
    return;

  const userId = event.source?.userId ?? "anonymous";
  if (event.source?.userId && event.source.userId !== lastSeenUserId) {
    lastSeenUserId = event.source.userId;
    console.log(`👤 訊息來自 userId: ${lastSeenUserId}`);
  }

  // 每則進來的訊息都記一筆，方便追問題（含 LINE 的「引用回覆」標記）
  const quotedFlag = event.message.quotedMessageId ? "（引用回覆）" : "";
  const peek =
    event.message.type === "text" ? `：${(event.message.text || "").slice(0, 30)}` : "";
  console.log(`📩 收到 ${event.message.type}${quotedFlag}${peek}`);

  // 鬧鐘控制詞（只在有「等你回」的提醒時生效）：
  //   later → 全部延後一小時再提醒；pass → 全部略過、不再提醒。
  const ctrl = event.message.type === "text" ? (event.message.text || "").trim().toLowerCase() : "";
  const pend = pendingQuestions.get(userId);
  if (pend && pend.length && (ctrl === "later" || ctrl === "pass")) {
    let reply;
    if (ctrl === "later") {
      const n = snoozeNudges(userId);
      reply = `好，一小時後再提醒你 ⏰（${n} 則待回）`;
    } else {
      clearNudgeEntries(userId, [...pend]);
      reply = "好，這個就略過、不再提醒 👌";
    }
    recordTranscript(ownerName(), event.message.text);
    await sendReply(event, userId, reply);
    recordTranscript(assistantName(), reply);
    return;
  }

  let answer;
  let userText = null; // Casper 這則的文字內容（文字／語音轉錄），給「答到哪題」判斷用
  // 進對話存檔的「Casper 這則」文字表示（圖片/檔案存佔位字，語音存轉錄）
  let inboundLog =
    event.message.type === "text"
      ? event.message.text
      : event.message.type === "image"
      ? "（傳了圖片）"
      : event.message.type === "file"
      ? `（傳了檔案：${event.message.fileName || "檔案"}）`
      : "（語音訊息）";

  // Demo 用量護欄：超過每日上限就婉拒（保護那把付費 key），不呼叫 Claude
  const gate = checkDemoLimit(userId);
  if (!gate.allowed) {
    const msg = demoLimitMessage(gate);
    recordTranscript(ownerName(), inboundLog);
    await sendReply(event, userId, msg);
    recordTranscript(assistantName(), msg);
    return;
  }
  countDemoUse(userId);

  try {
    if (event.message.type === "image") {
      const { base64, mediaType } = await downloadLineContent(
        event.message.id
      );
      answer =
        base64.length > MAX_IMAGE_BASE64_CHARS
          ? "這張圖太大了，我吃不下 😵 請截圖或壓縮後再傳一次。"
          : await ask77Image(userId, { base64, mediaType });
    } else if (event.message.type === "file") {
      const fileName = event.message.fileName || "檔案";
      if (!/\.pdf$/i.test(fileName)) {
        answer = `目前我只讀得懂 PDF（你傳的是 ${fileName}）。可以的話轉成 PDF 再傳一次 🙏`;
      } else {
        const { base64 } = await downloadLineContent(event.message.id);
        answer =
          base64.length > MAX_PDF_BASE64_CHARS
            ? "這份 PDF 太大了（超過 ~15MB），我吃不下 😵 可以截重點頁或壓縮後再傳。"
            : await ask77Document(userId, { base64, fileName });
      }
    } else if (event.message.type === "audio") {
      if (!transcribeConfigured) {
        answer = "語音功能還沒開（缺 OPENAI_API_KEY），先打字跟我說吧 🙏";
      } else {
        const { base64, mediaType } = await downloadLineContent(
          event.message.id
        );
        const transcript = await transcribe(
          Buffer.from(base64, "base64"),
          mediaType
        );
        if (transcript) {
          userText = transcript;
          inboundLog = `（語音）${transcript}`;
          answer = await ask77(userId, `（Casper 用語音說）${transcript}`);
        } else {
          inboundLog = "（語音，聽不出內容）";
          answer = "這段語音我聽不出內容 😅 再說一次或打字給我？";
        }
      }
    } else {
      userText = event.message.text;
      answer = await ask77(userId, event.message.text);
    }
  } catch (err) {
    console.error("Claude 回覆失敗：", err);
    answer = "77 這邊出了點狀況，等一下再試試看 🙏";
  }

  await sendReply(event, userId, answer);

  // 完整對話存檔（append-only，照日期累積）：先記 Casper、再記 77
  recordTranscript(ownerName(), inboundLog);
  recordTranscript(assistantName(), answer);

  // ── 「等你回答」鬧鐘維護（回覆已送出後才做，不影響回覆速度）──
  try {
    // 1) Casper 這則訊息回答到哪些還沒答的題 → 取消那幾題的鬧鐘
    //    （單純換話題、講別的事不會清掉沒答的題目）
    const pending = pendingQuestions.get(userId);
    if (userText && pending && pending.length) {
      const answered = await classifyAnsweredQuestions(
        pending.map((e) => e.text),
        userText
      );
      clearNudgeEntries(userId, answered.map((i) => pending[i]).filter(Boolean));
    }
    // 2) 77 這則回覆若在問問題、等回答 → 新增一個 1 小時鬧鐘
    addQuestionNudge(userId, answer);
  } catch (err) {
    console.error("問題鬧鐘維護失敗：", err);
  }
}

app.listen(port, () => {
  // 載入 /settings 網頁存的覆寫進同步快取（沒接 Sheets 時是 no-op，全回退 env/預設）
  loadSettings()
    .then(() => console.log("⚙️ settings 覆寫已載入"))
    .catch((e) => console.error("⚠️ settings 載入失敗，先用 env/預設：", e.message));
  console.log(`✅ ${assistantName()} 啟動，listening on ${port}`);
  if (demoLimitOn) console.log("🎟️ Demo 用量護欄已啟用（每日上限）");
  if (briefingUserId) {
    const push = async (text) =>
      client.pushMessage({
        to: briefingUserId,
        messages: [{ type: "text", text }],
      });
    // 晨報／週回顧不走 notePush，所以這版 push 順手記進存檔；
    // 會議監看自己會 notePush（那裡記存檔），用上面的純 push 即可，避免雙重記錄。
    const pushLogged = async (text) => {
      await push(text);
      recordTranscript(assistantName(), text);
    };
    startBriefingScheduler(pushLogged);
    startWeeklyScheduler(pushLogged);
    startMeetingWatcher({
      push,
      notePush: (text) => notePush(briefingUserId, text),
      // 會後提示沒回 → 1 小時補「?」（force：那則結尾不是問號，靠明確標記）
      onAwaitReply: (text) => addQuestionNudge(briefingUserId, text, true),
    });
  } else {
    console.warn("⚠️ 未設 OWNER_LINE_USER_ID，晨報／週回顧／會議監看都未啟動（可先用 /brief 測試）");
  }
});
