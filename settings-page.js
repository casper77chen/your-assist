// /settings 網頁設定頁：把助理的身分、口吻、簡稱、快捷、每一段行為規則（prompt 區塊）
// 全部攤在一頁上可檢視 / 編輯 / 還原。對應 FRAMEWORK.md 的 M3.5。
// 視覺套用 WCA Design System（午夜藍 × 榮耀金、襯線標題、金箔 CTA、45° 細斜紋；避免 emoji/泡泡圓角）。
//
// 儲存模型（settings.js 的核心約定）：覆寫(settings) → env → 程式預設。
// - 文字欄留空 = 還原該欄預設。
// - prompt 區塊：送出值若等於預設就不存覆寫（保持「還原」語意、之後改預設也會自動跟上）。
import { listBlocks, buildSystemPrompt } from "./system-prompt.js";
import { buildTools } from "./assistant.js";
import {
  setSetting,
  resetSetting,
  overrideOf,
  settingsWritable,
} from "./settings.js";
import { assistantName } from "./profile.js";
import { listConnectors } from "./connectors.js";

const esc = (s) =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

// ── 品牌 / 身分欄位 ───────────────────────────────────────
const BRANDING = [
  { key: "assistant_name", label: "助理名字", env: "ASSISTANT_NAME", def: "小助", ph: "例：小幫" },
  { key: "owner_name", label: "主人稱呼（prompt 裡怎麼指你本人）", env: "OWNER_NAME", def: "主人", ph: "例：阿明" },
  { key: "owner_nickname", label: "主人暱稱（助理回你話時叫你）", env: "OWNER_NICKNAME", def: "同主人稱呼", ph: "例：明哥" },
  { key: "assistant_persona", label: "口吻補充（接在核心人格後）", env: "ASSISTANT_PERSONA", def: "無", ph: "例：偶爾可以幽默一點", area: true },
  { key: "owner_abbreviations", label: "常用簡稱對照", env: "OWNER_ABBREVIATIONS", def: "無", ph: "con=人脈庫,wiki=知識庫" },
];

// 快捷（會議室 / 同事）JSON
const SHORTCUTS = [
  { key: "rooms_json", label: "會議室快捷（JSON）", env: "ROOMS_JSON", ph: '{"A":{"email":"...@resource.calendar.google.com","name":"大會議室"}}' },
  { key: "contacts_json", label: "同事快捷（JSON）", env: "CONTACTS_JSON", ph: '{"小明":"ming@example.com"}' },
];

function currentRaw(key, env) {
  return overrideOf(key) ?? process.env[env] ?? "";
}
function sourceTag(key, env) {
  if (overrideOf(key) !== undefined) return '<span class="tag ov">已覆寫</span>';
  if ((process.env[env] || "").trim()) return '<span class="tag env">環境變數</span>';
  return '<span class="tag def">預設</span>';
}

function brandingFieldHtml(f) {
  const val = currentRaw(f.key, f.env);
  const input = f.area
    ? `<textarea name="f_${f.key}" rows="2" placeholder="${esc(f.ph)}">${esc(val)}</textarea>`
    : `<input type="text" name="f_${f.key}" value="${esc(val)}" placeholder="${esc(f.ph)}">`;
  return `<div class="field">
    <label>${esc(f.label)} ${sourceTag(f.key, f.env)}</label>
    ${input}
    <p class="hint">留空 = 還原預設（${esc(f.def)}）</p>
  </div>`;
}

function shortcutFieldHtml(f) {
  const val = currentRaw(f.key, f.env);
  return `<div class="field">
    <label>${esc(f.label)} ${sourceTag(f.key, f.env)}</label>
    <textarea name="f_${f.key}" rows="3" class="mono" placeholder="${esc(f.ph)}">${esc(val)}</textarea>
    <p class="hint">留空 = 不啟用此快捷</p>
  </div>`;
}

function blockFieldHtml(b) {
  const status = b.enabled
    ? '<span class="tag on">啟用中</span>'
    : '<span class="tag off">未啟用</span>';
  const ov = b.isOverridden ? '<span class="tag ov">已覆寫</span>' : "";
  return `<details class="block" ${b.isOverridden ? "open" : ""}>
    <summary>${esc(b.title)} ${status} ${ov}</summary>
    <textarea name="f_${b.key}" rows="6" class="mono" ${b.enabled ? "" : "disabled"}>${esc(b.text)}</textarea>
    <label class="reset"><input type="checkbox" name="r_${b.key}"> 還原此區塊預設</label>
  </details>`;
}

// 連接器卡片（每個可連結的外部系統一張）
function connectorCard(c, setupKey) {
  const dot = c.isConnected ? "on" : "off";
  const state = c.isConnected ? "已連結" : "未連結";
  const chips = c.enables.map((e) => `<span class="chip">${esc(e)}</span>`).join("");
  const detail = c.isConnected
    ? c.note
      ? `<p class="hint">${esc(c.note)}</p>`
      : ""
    : `<p class="hint">需要環境變數：${c.missing.map(esc).join("、") || "—"}</p>`;
  const link = c.setupPath
    ? `<a class="connect${c.isConnected ? " ghosted" : ""}" href="${c.setupPath}?key=${encodeURIComponent(setupKey || "")}">${c.isConnected ? "重新驗證" : esc(c.setupLabel) + " →"}</a>`
    : "";
  return `<div class="connector">
    <div class="ctop"><span class="dot ${dot}"></span><b>${esc(c.name)}</b><span class="cstate">${state}</span></div>
    <p class="ccat">${esc(c.category)}</p>
    <p class="cblurb">${esc(c.blurb)}</p>
    <div class="chips">${chips}</div>
    ${detail}
    ${link}
  </div>`;
}

function connectorsHtml(setupKey) {
  const cards = listConnectors().map((c) => connectorCard(c, setupKey)).join("");
  let toolCount = 0;
  try {
    toolCount = buildTools().length;
  } catch {
    toolCount = -1;
  }
  return `<div class="connectors">${cards}</div>
    <p class="hint">目前提供給 AI 的工具數：<b>${toolCount < 0 ? "—" : toolCount}</b> 個（純聊天 = 0；連上能力才會增加）。LINE 與 Anthropic 是核心、必備，不在此列。</p>`;
}

function sectionHead(no, eyebrow, title, desc) {
  return `<p class="eyebrow">${esc(no)} · ${esc(eyebrow)}</p>
    <h2>${esc(title)}</h2>
    ${desc ? `<p class="desc">${esc(desc)}</p>` : ""}`;
}

export function renderSettingsPage({ setupKey, saved = false } = {}) {
  const blocks = listBlocks();
  const keyQ = `?key=${encodeURIComponent(setupKey || "")}`;
  const ro = !settingsWritable;

  const savedBanner = saved
    ? `<div class="banner ok">已儲存。改動即時生效，不必重開助理。</div>`
    : "";
  const roBanner = ro
    ? `<div class="banner warn">目前未接 Google Sheets（缺 MEMORY_SPREADSHEET_ID），設定為唯讀、改了不會存。先設好試算表即可編輯。</div>`
    : "";

  const preview = esc(buildSystemPrompt());

  return `<!doctype html><html lang="zh-Hant"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(assistantName())}・設定</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@300;400;500;700&family=Noto+Serif+TC:wght@600;700;900&family=Playfair+Display:wght@400;700&display=swap" rel="stylesheet">
<style>
:root{
 --ink-900:#09182B; --ink-800:#0F1F3A; --ink-700:#1A2F4A;
 --gold-100:#F0D695; --gold-500:#C8A359; --gold-700:#9E7D3D;
 --white:#FFFFFF; --text:#E5E7EB; --line:#CBD5E1; --muted:#94A3B8;
 --danger:#EF4444; --success:#7BCBA6;
 --gold-grad:linear-gradient(135deg,#F0D695 0%,#C8A359 50%,#9E7D3D 100%);
 --border:rgba(200,163,89,.28); --border-strong:rgba(200,163,89,.5);
 --font-serif:"Noto Serif TC",Georgia,serif;
 --font-sans:"Noto Sans TC",-apple-system,system-ui,sans-serif;
 --font-eng:"Playfair Display",serif;
 --pinstripe:repeating-linear-gradient(45deg,transparent 0,transparent 2px,rgba(200,163,89,.025) 2px,rgba(200,163,89,.025) 4px);
 --spotlight:radial-gradient(ellipse at top,rgba(240,214,149,.10) 0%,rgba(9,24,43,0) 55%);
}
*{box-sizing:border-box}
html{color-scheme:dark}
body{margin:0 auto;max-width:780px;padding:0 20px 96px;color:var(--text);
 font-family:var(--font-sans);font-size:16px;line-height:1.7;
 background:var(--spotlight),var(--pinstripe),var(--ink-900);background-attachment:fixed}
a{color:var(--gold-500)}

.hero{padding:56px 4px 20px;text-align:left}
.hero .eyebrow{margin:0 0 14px}
.hero h1{font-family:var(--font-serif);font-weight:700;font-size:clamp(30px,6.5vw,50px);
 line-height:1.12;letter-spacing:-.01em;color:var(--white);margin:0 0 12px}
.hero h1 .gold{background:var(--gold-grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.hero .lead{color:var(--line);font-size:16px;margin:0;max-width:34em}
.hero .herocta{display:inline-block;margin-top:16px;font-size:13px;font-weight:600;letter-spacing:.04em;
 color:var(--gold-500);text-decoration:none;border:1px solid var(--border-strong);border-radius:7px;padding:9px 18px}
.hero .herocta:hover{background:rgba(200,163,89,.08)}

.eyebrow{font-family:var(--font-eng);font-weight:400;font-size:11px;letter-spacing:.28em;
 text-transform:uppercase;color:var(--gold-500);margin:0 0 8px}

.banner{border-radius:8px;padding:12px 16px;margin:16px 0;font-size:14px;border:1px solid var(--border)}
.banner.ok{background:rgba(123,203,166,.10);color:var(--success);border-color:rgba(123,203,166,.4)}
.banner.warn{background:rgba(245,158,11,.10);color:#F0C36B;border-color:rgba(245,158,11,.4)}

section.card{border:1px solid var(--border);border-radius:8px;padding:24px 22px;margin:18px 0;
 background:rgba(9,24,43,.55)}
section.card h2{font-family:var(--font-serif);font-weight:700;font-size:21px;line-height:1.3;
 color:var(--white);margin:0 0 4px}
section.card .desc{color:var(--muted);font-size:13.5px;margin:0 0 18px}

.field{margin:0 0 18px}
.field label{display:block;font-size:14px;font-weight:500;color:var(--text);margin:0 0 7px}
input[type=text],textarea{width:100%;padding:11px 13px;border:1px solid var(--border);border-radius:6px;
 font:inherit;color:var(--text);background:rgba(9,24,43,.6)}
input[type=text]:focus,textarea:focus{outline:none;border-color:var(--gold-500);
 box-shadow:0 0 0 3px rgba(200,163,89,.15)}
textarea{resize:vertical}
.mono{font-family:Montserrat,ui-monospace,Menlo,monospace;font-size:13px;line-height:1.55}
.hint{color:var(--muted);font-size:12px;margin:6px 0 0}

.tag{display:inline-block;font-family:var(--font-eng);font-size:10px;letter-spacing:.1em;text-transform:uppercase;
 font-weight:700;padding:2px 9px;border-radius:999px;vertical-align:middle;margin-left:4px;border:1px solid transparent}
.tag.ov{color:var(--gold-100);border-color:var(--border-strong);background:rgba(200,163,89,.12)}
.tag.env{color:var(--line);border-color:rgba(203,213,225,.3)}
.tag.def{color:var(--muted);border-color:rgba(148,163,184,.3)}
.tag.on{color:var(--gold-500);border-color:var(--border-strong)}
.tag.off{color:var(--muted);border-color:rgba(148,163,184,.25)}

details.block{border:1px solid var(--border);border-radius:6px;padding:10px 14px;margin:0 0 10px;
 background:rgba(15,31,58,.5)}
details.block summary{cursor:pointer;font-size:14px;font-weight:500;color:var(--text);list-style:none}
details.block summary::-webkit-details-marker{display:none}
details.block summary::before{content:"▸";color:var(--gold-500);margin-right:8px;font-size:12px}
details.block[open] summary::before{content:"▾"}
details.block textarea{margin:12px 0 6px}
label.reset{font-size:13px;font-weight:400;color:var(--muted);display:flex;gap:7px;align-items:center;cursor:pointer}

ul.caps{list-style:none;padding:0;margin:0 0 4px}
ul.caps li{display:flex;align-items:center;gap:10px;padding:7px 0;font-size:14.5px;border-bottom:1px solid rgba(200,163,89,.10)}
ul.caps li:last-child{border-bottom:0}
.dot{width:8px;height:8px;border-radius:999px;flex:0 0 auto}
.dot.on{background:var(--gold-500);box-shadow:0 0 0 3px rgba(200,163,89,.18)}
.dot.off{background:var(--muted);opacity:.5}
.capstate{margin-left:auto;font-family:var(--font-eng);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}

.btnbar{position:sticky;bottom:0;margin-top:8px;padding:18px 0;
 background:linear-gradient(transparent,var(--ink-900) 38%)}
button{font-family:var(--font-sans);font-weight:600;font-size:16px;letter-spacing:.04em;
 padding:15px 28px;border-radius:8px;border:0;cursor:pointer;width:100%}
button.primary{background:var(--gold-grad);color:var(--ink-900);
 box-shadow:0 0 0 1px rgba(200,163,89,.45),0 14px 40px rgba(200,163,89,.22)}
button.ghost{background:transparent;color:var(--text);border:1px solid var(--border-strong)}
button:disabled{opacity:.45;cursor:not-allowed;box-shadow:none}
.escape{margin-top:22px;text-align:center}
.escape button{width:auto;padding:11px 22px;font-size:13px;color:var(--muted);border-color:rgba(148,163,184,.3)}

.connectors{display:flex;flex-direction:column;gap:12px}
.connector{border:1px solid var(--border);border-radius:8px;padding:14px 16px;background:rgba(15,31,58,.4)}
.connector .ctop{display:flex;align-items:center;gap:9px}
.connector .ctop b{font-size:15px;color:var(--white);font-weight:700}
.connector .cstate{margin-left:auto;font-family:var(--font-eng);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.connector .ccat{font-family:var(--font-eng);font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--gold-500);margin:9px 0 7px}
.connector .cblurb{font-size:13.5px;color:var(--line);margin:0 0 10px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px}
.chip{font-size:11px;color:var(--text);border:1px solid var(--border);border-radius:999px;padding:2px 9px;background:rgba(200,163,89,.06)}
a.connect{display:inline-block;margin-top:6px;font-size:13px;font-weight:600;color:var(--ink-900);text-decoration:none;
 background:var(--gold-grad);padding:9px 16px;border-radius:7px}
a.connect.ghosted{background:transparent;color:var(--gold-500);border:1px solid var(--border-strong)}
pre.preview{white-space:pre-wrap;word-break:break-word;
 font-family:Montserrat,ui-monospace,Menlo,monospace;font-size:11.5px;line-height:1.55;
 background:#06101E;color:var(--line);padding:16px;border-radius:8px;border:1px solid var(--border);
 max-height:400px;overflow:auto}
</style></head><body>

<header class="hero">
  <p class="eyebrow">Your Assistant · 設定</p>
  <h1>從 77 助理，<br>到<span class="gold">你的</span>助理</h1>
  <p class="lead">改個名字、調個口吻、留下你要的規則——這頁存什麼，助理就變成什麼。</p>
  <a class="herocta" href="/guide${keyQ}">使用說明 →</a>
</header>
${savedBanner}${roBanner}

<form method="post" action="/settings${keyQ}">

<section class="card">
  ${sectionHead("01", "Identity", "身分・口吻", "最少改這兩個（助理名字、主人稱呼），它就是「你的」助理了。")}
  ${BRANDING.map(brandingFieldHtml).join("")}
</section>

<section class="card">
  ${sectionHead("02", "Connectors", "連接器（選擇要連結的外部系統）", "接上外部帳號，對應能力就開——Connectome 連起來就能做人脈管理，其他陸續擴充。")}
  ${connectorsHtml(setupKey)}
</section>

<section class="card">
  ${sectionHead("03", "Shortcuts", "快捷（會議室・同事）", "講代號或名字就認得；用 JSON 填，可留空。")}
  ${SHORTCUTS.map(shortcutFieldHtml).join("")}
</section>

<section class="card">
  ${sectionHead("04", "Behavior", "行為規則（每段都可改 / 還原）", "這是助理的 system prompt，拆成一段段。每段預設都寫死在程式裡，勾「還原」或清空就回原廠——改壞了救得回來。未啟用能力的段落不會送進 AI。")}
  ${blocks.map(blockFieldHtml).join("")}
</section>

<section class="card">
  ${sectionHead("05", "Preview", "目前實際送進 AI 的完整 prompt", "套用上面所有設定後組出來的樣子（含啟用的能力段落）。")}
  <pre class="preview">${preview}</pre>
</section>

<div class="btnbar">
  <button type="submit" class="primary"${ro ? " disabled" : ""}>儲存設定</button>
</div>
</form>

<div class="escape">
  <form method="post" action="/settings/reset${keyQ}" onsubmit="return confirm('確定把所有覆寫清掉、整個助理回到原廠預設？')">
    <button type="submit" class="ghost"${ro ? " disabled" : ""}>還原全部（逃生門）</button>
  </form>
</div>

</body></html>`;
}

// ── /guide：使用說明（onboarding 介紹頁，WCA 風）──────────────
const GUIDE_STEPS = [
  {
    no: "01",
    eyebrow: "Keys",
    title: "拿兩把必備金鑰",
    body: "LINE Messaging API 的 Channel secret + access token；Anthropic API key（大腦）。把官方帳號的「自動回應」關掉。",
  },
  {
    no: "02",
    eyebrow: "Deploy",
    title: "部署 + 設環境變數",
    body: "任何能跑 Node ≥ 20 的地方都行。最少填 LINE 兩把、ANTHROPIC_API_KEY、ASSISTANT_NAME、OWNER_NAME、SETUP_KEY。",
  },
  {
    no: "03",
    eyebrow: "Webhook",
    title: "接上 LINE",
    body: "LINE 後台 Webhook URL 填「你的網域/webhook」並開啟。傳「哈囉」會自然回覆＝管線通了。",
  },
  {
    no: "04",
    eyebrow: "Make it yours",
    title: "改名換口吻",
    body: "回這個設定頁改名字、稱呼、口吻、簡稱——到這裡你已經有一個純聊天、屬於你的助理。",
  },
  {
    no: "05",
    eyebrow: "Connectors",
    title: "逐步連上能力",
    body: "在設定頁②的連接器卡片，連 Google（行事曆/記憶/待辦）、Connectome（人脈管理），其他陸續擴充。連上哪個，能力就開。",
  },
  {
    no: "06",
    eyebrow: "Push",
    title: "主動推播（選用）",
    body: "設 OWNER_LINE_USER_ID 後，每天晨報、每週週回顧主動推給你；會議前推與會者背景。",
  },
];

export function renderGuidePage({ setupKey } = {}) {
  const keyQ = setupKey ? `?key=${encodeURIComponent(setupKey)}` : "";
  const cards = GUIDE_STEPS.map(
    (s) => `<section class="card">
      <p class="eyebrow">Step ${esc(s.no)} · ${esc(s.eyebrow)}</p>
      <h2>${esc(s.title)}</h2>
      <p class="desc">${esc(s.body)}</p>
    </section>`
  ).join("");

  return `<!doctype html><html lang="zh-Hant"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(assistantName())}・使用說明</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&family=Noto+Serif+TC:wght@700&family=Playfair+Display&display=swap" rel="stylesheet">
<style>
:root{--ink:#09182B;--gold:#C8A359;--gold100:#F0D695;--gold700:#9E7D3D;--white:#fff;--text:#E5E7EB;--line:#CBD5E1;--muted:#94A3B8;--border:rgba(200,163,89,.28);--border2:rgba(200,163,89,.5);
 --grad:linear-gradient(135deg,#F0D695 0%,#C8A359 50%,#9E7D3D 100%);color-scheme:dark}
*{box-sizing:border-box}
body{font-family:"Noto Sans TC",-apple-system,system-ui,sans-serif;font-size:16px;line-height:1.7;color:var(--text);
 margin:0 auto;max-width:720px;padding:0 20px 72px;
 background:radial-gradient(ellipse at top,rgba(240,214,149,.10) 0%,rgba(9,24,43,0) 55%),
 repeating-linear-gradient(45deg,transparent 0,transparent 2px,rgba(200,163,89,.025) 2px,rgba(200,163,89,.025) 4px),var(--ink);
 background-attachment:fixed}
.hero{padding:52px 4px 18px}
.hero .eyebrow{margin:0 0 12px}
.hero h1{font-family:"Noto Serif TC",serif;font-weight:700;font-size:clamp(28px,6vw,44px);line-height:1.14;color:var(--white);margin:0 0 12px}
.hero .lead{color:var(--line);font-size:16px;margin:0;max-width:34em}
.eyebrow{font-family:"Playfair Display",serif;font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:var(--gold);margin:0 0 8px}
section.card{border:1px solid var(--border);border-radius:8px;padding:20px 22px;margin:14px 0;background:rgba(9,24,43,.55)}
section.card h2{font-family:"Noto Serif TC",serif;font-weight:700;font-size:20px;color:var(--white);margin:0 0 6px}
section.card .desc{color:var(--line);font-size:14.5px;margin:0}
.cta{display:inline-block;margin:8px 0 0;font-size:15px;font-weight:600;letter-spacing:.04em;color:var(--ink);
 background:var(--grad);padding:14px 26px;border-radius:8px;text-decoration:none;
 box-shadow:0 0 0 1px rgba(200,163,89,.45),0 14px 40px rgba(200,163,89,.22)}
.foot{color:var(--muted);font-size:12.5px;margin-top:18px}
.foot a{color:var(--gold)}
</style></head><body>
<header class="hero">
  <p class="eyebrow">Your Assistant · 使用說明</p>
  <h1>把它變成你的助理，<br>只要幾步</h1>
  <p class="lead">先用最小設定跑起來（純聊天），確認管線通了，再一個一個連上能力。</p>
</header>
${cards}
<section class="card" style="text-align:center;border-color:${"rgba(200,163,89,.5)"}">
  <p class="eyebrow">Start</p>
  <h2>準備好了？</h2>
  <p class="desc" style="margin-bottom:14px">回設定頁改名字、看連接器、編規則。</p>
  <a class="cta" href="/settings${keyQ}">前往設定頁 →</a>
</section>
<p class="foot">完整逐步（含 Google OAuth、Connectome 帳密、環境變數總覽）見原始碼的 <a href="https://github.com/">ONBOARDING.md</a>。</p>
</body></html>`;
}

// 處理 POST：套用表單到 settings 覆寫。
export async function applySettings(body = {}) {
  // 品牌 + 快捷：留空 = 還原（settings.setSetting 對空值會自動 reset）
  for (const f of [...BRANDING, ...SHORTCUTS]) {
    await setSetting(f.key, (body["f_" + f.key] ?? "").toString());
  }
  // prompt 區塊：勾「還原」優先；否則送出值等於預設就不存覆寫
  for (const b of listBlocks()) {
    if (body["r_" + b.key]) {
      await resetSetting(b.key);
      continue;
    }
    const v = (body["f_" + b.key] ?? "").toString();
    if (v.trim() === (b.def || "").trim()) await resetSetting(b.key);
    else await setSetting(b.key, v);
  }
}
