// Phase 3：Connectome 人脈管理 API client
// 77 以 Casper 本人身分登入 Connectome（connectome.com.tw），讀寫 people / interactions /
// relationships / tags。Connectome 端不需任何改動。
const BASE_URL = (process.env.CONNECTOME_BASE_URL || "https://connectome.com.tw").replace(
  /\/$/,
  ""
);
const email = process.env.CONNECTOME_EMAIL;
const password = process.env.CONNECTOME_PASSWORD;

export const connectomeConfigured = Boolean(email && password);

// Connectome 允許的標籤型別與關係型別
const TAG_TYPES = new Set([
  "region", "industry", "identity", "organization", "skill",
  "interest", "resource", "project", "relationship_status",
]);

// ── 認證（JWT 存 RAM，401 自動重登）────────────────────────
let token = null;

async function login() {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) {
    throw new Error(
      `Connectome 登入失敗（${res.status}）：${data.message || "未知錯誤"}`
    );
  }
  token = data.token;
  return data; // { success, token, user }
}

async function authedFetch(path, opts = {}, retry = true) {
  if (!connectomeConfigured) {
    throw new Error("Connectome 尚未設定（缺 CONNECTOME_EMAIL / CONNECTOME_PASSWORD）");
  }
  if (!token) await login();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401 && retry) {
    token = null;
    await login();
    return authedFetch(path, opts, false);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new Error(
      `Connectome ${path} 失敗（${res.status}）：${data.message || "未知錯誤"}`
    );
  }
  return data;
}

// ── 工具函式 ────────────────────────────────────────────────
function norm(s) {
  return (s || "").toString().toLowerCase().replace(/\s+/g, "").trim();
}

// 電話正規化：只留數字、去掉 +886 / 開頭 0，方便比對是否同一支。
function normPhone(s) {
  let d = (s || "").toString().replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("886")) d = d.slice(3);
  if (d.startsWith("0")) d = d.slice(1);
  return d;
}

// 把 1980/2/6、1980.2.6、1980-2-6 正規化成 1980-02-06（Connectome 的 DATE 要 YYYY-MM-DD）
function normDate(s) {
  if (!s || typeof s !== "string") return s;
  const m = s.trim().match(/^(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})$/);
  if (!m) return s;
  const [, y, mo, d] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

// ── people（RAM 快取 + TTL + 寫入後刷新）─────────────────────
let peopleCache = null;
let peopleCacheAt = 0;

export async function getPeople({ force = false } = {}) {
  const now = Date.now();
  if (!force && peopleCache && now - peopleCacheAt < CACHE_TTL_MS) return peopleCache;
  const data = await authedFetch("/api/app/people");
  const tagsByPerson = data.personTags || {};
  peopleCache = (data.data || []).map((p) => ({
    ...p,
    tags: tagsByPerson[String(p.id)] || [],
  }));
  peopleCacheAt = now;
  return peopleCache;
}

export async function syncPeople() {
  const people = await getPeople({ force: true });
  return people.length;
}

function slimPerson(p) {
  return {
    id: p.id,
    name: p.name,
    english_name: p.english_name || undefined,
    nickname: p.nickname || undefined,
    company: p.company || undefined,
    title: p.title || undefined,
    email: p.email || undefined,
    phone: p.phone || undefined,
    city: p.city || undefined,
    birthday: p.birthday || undefined,
    first_met_date: p.first_met_date || undefined,
    first_met_place: p.first_met_place || undefined,
    notes: p.notes || undefined,
    tags: (p.tags || []).map((t) => t.name),
  };
}

// 模糊比對聯絡人：完全相符 > 子字串 > 同姓首字。回候選（給 77 判斷，對不到就問）。
export async function findPeople(queryStr, limit = 5) {
  const q = norm(queryStr);
  if (!q) return [];
  const people = await getPeople();
  const scored = [];
  for (const p of people) {
    const fields = [p.name, p.english_name, p.nickname, p.email, p.company].map(norm);
    let score = 0;
    for (const f of fields) {
      if (!f) continue;
      if (f === q) score = Math.max(score, 3);
      else if (f.includes(q) || q.includes(f)) score = Math.max(score, 2);
    }
    if (!score && p.name) {
      const n = norm(p.name);
      if (n && n[0] === q[0]) score = 1; // 同姓弱比對（如「王醫師」對到姓王的人）
    }
    if (score) scored.push({ score, person: p });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => slimPerson(s.person));
}

// 嚴格比對「是否已經有這個人」（比 findPeople 嚴格，專門用來擋重複建檔）：
// 只認三種強訊號——電話相同、email 相同、或姓名完全相同且公司不衝突。
// 對到就回那個既有的人，否則回 null。
export async function findDuplicatePerson(fields = {}) {
  const people = await getPeople();
  const phone = normPhone(fields.phone);
  const emailN = norm(fields.email);
  const nameN = norm(fields.name);
  // 電話 / email 完全相同 → 幾乎一定是同一人
  for (const p of people) {
    if (phone && normPhone(p.phone) === phone) return p;
    const pe = norm(p.email);
    if (emailN && pe && pe === emailN) return p;
  }
  // 姓名完全相同，且公司也相同或其中一方沒填公司 → 視為同一人
  if (nameN) {
    const c1 = norm(fields.company);
    for (const p of people) {
      if (norm(p.name) !== nameN) continue;
      const c2 = norm(p.company);
      if (!c1 || !c2 || c1 === c2) return p;
    }
  }
  return null;
}

const MERGEABLE_FIELDS = [
  "english_name", "nickname", "company", "title", "email", "phone",
  "birthday", "city", "first_met_date", "first_met_place",
];

// 既有的人 vs 新資料：空欄位一律補上、notes 用追加（不覆蓋）。
// overwrite=true（建檔去重，預設）：不同值以新資料為準（新資訊覆蓋舊的）。
// overwrite=false（清理舊重複）：只補空欄，主檔既有值一律保留不動。
// 回傳只含「真的要改的欄位」的 patch；沒東西要改就回 {}。
function mergePersonFields(existing, incoming, { overwrite = true } = {}) {
  const patch = {};
  for (const f of MERGEABLE_FIELDS) {
    const nv = incoming[f];
    if (nv == null || nv === "") continue;
    const ev = existing[f];
    if (!ev) patch[f] = nv; // 補空欄位
    else if (overwrite && norm(ev) !== norm(nv)) patch[f] = nv; // 只有建檔模式才覆蓋
  }
  if (incoming.notes) {
    const old = existing.notes || "";
    if (!norm(old).includes(norm(incoming.notes))) {
      patch.notes = old ? `${old}\n${incoming.notes}` : incoming.notes; // 追加，不蓋掉舊備註
    }
  }
  return patch;
}

// 新增聯絡人，但先擋重複：撞到既有的人就改成「更新」而非「新增」。
// 回傳 { person, action: 'created'|'updated', changed, existing }。
// allowDuplicate=true 可強制另建一筆（極少用，例如真的有兩個同名同電話的人）。
export async function createPerson(fields, { allowDuplicate = false } = {}) {
  if (!allowDuplicate) {
    const dup = await findDuplicatePerson(fields);
    if (dup) {
      const patch = mergePersonFields(dup, fields);
      const changed = Object.keys(patch);
      const person = changed.length ? await updatePerson(dup.id, patch) : dup;
      return { person, action: "updated", changed, existing: dup };
    }
  }
  const body = { ...fields };
  if (body.birthday) body.birthday = normDate(body.birthday);
  if (body.anniversary) body.anniversary = normDate(body.anniversary);
  if (body.first_met_date) body.first_met_date = normDate(body.first_met_date);
  const data = await authedFetch("/api/app/people", {
    method: "POST",
    body: JSON.stringify(body),
  });
  await getPeople({ force: true });
  return { person: data.data, action: "created", changed: Object.keys(fields) };
}

export async function updatePerson(id, fields) {
  const body = { ...fields };
  if (body.birthday) body.birthday = normDate(body.birthday);
  if (body.anniversary) body.anniversary = normDate(body.anniversary);
  if (body.first_met_date) body.first_met_date = normDate(body.first_met_date);
  const data = await authedFetch(`/api/app/people/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  await getPeople({ force: true });
  return data.data;
}

export async function deletePerson(id) {
  await authedFetch(`/api/app/people/${id}`, { method: "DELETE" });
  await getPeople({ force: true });
  return true;
}

// 掃出「疑似同一人」的重複群組（清理舊資料用）。判準同 findDuplicatePerson：
// 電話相同／email 相同／同名且公司不衝突；用 union-find 把連在一起的併成一組。
// 回傳每組 [person, ...]（長度 >= 2），每個 person 是完整欄位。
export async function findDuplicateGroups() {
  const people = await getPeople();
  const parent = new Map(people.map((p) => [p.id, p.id]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const push = (map, key, p) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(p);
  };
  const byPhone = new Map(), byEmail = new Map(), byName = new Map();
  for (const p of people) {
    push(byPhone, normPhone(p.phone), p);
    push(byEmail, norm(p.email), p);
    push(byName, norm(p.name), p);
  }
  for (const list of byPhone.values())
    for (let i = 1; i < list.length; i++) union(list[0].id, list[i].id);
  for (const list of byEmail.values())
    for (let i = 1; i < list.length; i++) union(list[0].id, list[i].id);
  // 同名只在公司相容（相同或一方沒填）時才併，避免把不同公司的同名人併在一起
  for (const list of byName.values()) {
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const c1 = norm(list[i].company), c2 = norm(list[j].company);
        if (!c1 || !c2 || c1 === c2) union(list[i].id, list[j].id);
      }
  }
  const groups = new Map();
  for (const p of people) {
    const r = find(p.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(p);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

// 把 sourceIds 的資料併進 primaryId（空欄補上、不同值以來源為準、notes 追加）。
// 只動「主檔」一筆 PATCH，不刪任何人。回傳 { person, patch }。
export async function mergePersonInto(primaryId, sourceIds = []) {
  const people = await getPeople();
  const primary = people.find((p) => p.id === primaryId);
  if (!primary) throw new Error(`找不到主檔 id=${primaryId}`);
  let patch = {};
  for (const sid of sourceIds) {
    const src = people.find((p) => p.id === sid);
    if (!src) continue;
    const p2 = mergePersonFields({ ...primary, ...patch }, src, { overwrite: false });
    patch = { ...patch, ...p2 };
  }
  const person = Object.keys(patch).length
    ? await updatePerson(primaryId, patch)
    : primary;
  return { person, patch };
}

// ── interactions ───────────────────────────────────────────
export async function createInteraction(fields) {
  const body = { ...fields };
  if (body.date) body.date = normDate(body.date);
  if (body.follow_up_date) body.follow_up_date = normDate(body.follow_up_date);
  const data = await authedFetch("/api/app/interactions", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.data;
}

// 多人行程用：先建一個 Event，之後每筆 interaction 用 event_id 連過來
export async function createEvent({ name, date, location, notes }) {
  const body = {
    name,
    date: normDate(date),
    location: location || null,
    notes: notes || null,
  };
  const data = await authedFetch("/api/app/events", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.data;
}

export async function getInteractions() {
  const data = await authedFetch("/api/app/interactions");
  return data.data || [];
}

// 跟進清單：follow_up_date 在「今天 ~ N 天後」內，含逾期者，依日期排序。
export async function upcomingFollowups(days = 7) {
  const interactions = await getInteractions();
  const until = new Date();
  until.setHours(23, 59, 59, 999);
  until.setDate(until.getDate() + days);
  return interactions
    .filter((i) => i.follow_up_date)
    .map((i) => ({ i, fu: new Date(i.follow_up_date) }))
    .filter(({ fu }) => !isNaN(fu) && fu <= until)
    .sort((a, b) => a.fu - b.fu)
    .map(({ i }) => ({
      id: i.id,
      date: i.date,
      summary: i.summary,
      follow_up_date: i.follow_up_date,
      next_steps: i.next_steps || undefined,
      participants: (i.participants || []).map((p) => p.name),
    }));
}

// ── relationships（介紹用 type:'introducer'）────────────────
export async function createRelationship({ person_a_id, person_b_id, type, notes }) {
  const data = await authedFetch("/api/app/relationships", {
    method: "POST",
    body: JSON.stringify({
      person_a_id,
      person_b_id,
      type: type || "friend",
      notes: notes || null,
    }),
  });
  return data.data;
}

// ── tags（resource / interest 等）──────────────────────────
let tagsCache = null;
let tagsCacheAt = 0;

async function getTags(force = false) {
  const now = Date.now();
  if (!force && tagsCache && now - tagsCacheAt < CACHE_TTL_MS) return tagsCache;
  const data = await authedFetch("/api/app/tags");
  tagsCache = data.data || [];
  tagsCacheAt = now;
  return tagsCache;
}

async function findOrCreateTag(name, type) {
  const t = TAG_TYPES.has(type) ? type : "interest";
  const tags = await getTags();
  const existing = tags.find((x) => norm(x.name) === norm(name) && x.type === t);
  if (existing) return existing;
  const data = await authedFetch("/api/app/tags", {
    method: "POST",
    body: JSON.stringify({ name, type: t }),
  });
  await getTags(true);
  return data.data;
}

export async function tagPerson(personId, tagName, tagType) {
  const tag = await findOrCreateTag(tagName, tagType);
  await authedFetch("/api/app/tags/assign", {
    method: "POST",
    body: JSON.stringify({ tag_id: tag.id, target_type: "person", target_id: personId }),
  });
  await getPeople({ force: true });
  return tag;
}

// ── setup 驗證用 ───────────────────────────────────────────
export async function pingConnectome() {
  const auth = await login();
  const people = await getPeople({ force: true });
  return { user: auth.user, peopleCount: people.length };
}

// 組織清單（RAM 快取）。注意：Connectome 對外 API（/api/app/*）只能「讀」組織與
// 成員、無法寫入組織成員關係；所以 77 用 organization 型別的「tag」來標記某人屬於
// 哪個組織（POST /api/app/tags/assign 可寫）。組織實體的同學/校友成員需在 con UI 維護。
let orgsCache = null;
let orgsCacheAt = 0;
export async function listOrganizations(force = false) {
  const now = Date.now();
  if (!force && orgsCache && now - orgsCacheAt < CACHE_TTL_MS) return orgsCache;
  const data = await authedFetch("/api/app/organizations");
  orgsCache = data.data || [];
  orgsCacheAt = now;
  return orgsCache;
}

// 某人目前的組織成員（含次組織 community_id；PATCH orgIds/communityIds 是「整批取代」，
// 所以要先讀既有再合併，避免蓋掉別的組織或次組織）
export async function getPersonMemberships(personId) {
  const data = await authedFetch("/api/app/people/memberships");
  const map = data.data || {};
  return map[String(personId)] || []; // [{ id, name, type, community_id, community_name }]
}

// 某組織底下的次組織（communities，例如 AAMA 的「AAMA第七期」「APEC小組」）
export async function listOrgCommunities(orgId) {
  const data = await authedFetch(`/api/app/organizations/${orgId}/communities`);
  return data.data || [];
}

// 把某人加進某組織（＋可選次組織）。真正的 Organizations 成員，非只是 tag；con 端會自動補組織 tag。
// orgName：組織名（精確同名才直接用，否則回 needs_confirm 讓 77 確認或改用正確名稱）。
// subGroups：次組織名稱陣列（例如 ["七期","APEC小組"]）；會在該組織底下比對 community。
// create=true 才真的新建找不到的組織／次組織。
export async function addPersonToOrganization(personId, orgName, { type, create = false, subGroups = [] } = {}) {
  const orgs = await listOrganizations(true);
  let org = orgs.find((o) => norm(o.name) === norm(orgName));
  let created = false;
  if (!org) {
    if (!create) {
      const suggestions = orgs
        .filter((o) => norm(o.name).includes(norm(orgName)) || norm(orgName).includes(norm(o.name)))
        .map((o) => o.name);
      return { ok: false, needs_confirm: true, scope: "organization", suggestions, existing: orgs.map((o) => o.name) };
    }
    const data = await authedFetch("/api/app/organizations", {
      method: "POST",
      body: JSON.stringify({ name: orgName, type: type || "alumni" }),
    });
    org = data.data;
    orgsCache = null;
    created = true;
  }

  // 解析次組織（communities）
  const addCommunityIds = [];
  const addedCommunityNames = [];
  if (subGroups.length) {
    let comms = await listOrgCommunities(org.id);
    for (const sg of subGroups) {
      let c =
        comms.find((x) => norm(x.name) === norm(sg)) ||
        comms.find((x) => norm(x.name).includes(norm(sg)) || norm(sg).includes(norm(x.name)));
      if (!c) {
        if (!create) {
          const suggestions = comms
            .filter((x) => norm(x.name).includes(norm(sg)) || norm(sg).includes(norm(x.name)))
            .map((x) => x.name);
          return {
            ok: false,
            needs_confirm: true,
            scope: "community",
            org: { id: org.id, name: org.name },
            subGroup: sg,
            suggestions,
            existing: comms.map((x) => x.name),
          };
        }
        const data = await authedFetch(`/api/app/organizations/${org.id}/communities`, {
          method: "POST",
          body: JSON.stringify({ name: sg }),
        });
        c = data.data;
        comms = await listOrgCommunities(org.id);
      }
      addCommunityIds.push(c.id);
      addedCommunityNames.push(c.name);
    }
  }

  // 合併既有成員（保留別組織與既有次組織）
  const existing = await getPersonMemberships(personId);
  const orgIds = [...new Set([...existing.map((e) => e.id), org.id])];
  const communityIds = [
    ...new Set([...existing.map((e) => e.community_id).filter(Boolean), ...addCommunityIds]),
  ];
  await authedFetch(`/api/app/people/${personId}`, {
    method: "PATCH",
    body: JSON.stringify({ orgIds, communityIds }),
  });
  await getPeople({ force: true });
  return { ok: true, org, created, communities: addedCommunityNames };
}
