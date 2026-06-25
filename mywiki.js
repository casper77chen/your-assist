// Phase 7：MyWiki 整合（Casper 的個人決策日誌／知識庫）
// MyWiki 是獨立部署的知識系統（Next.js + PG），這裡只是它的 LINE 端 client。
// 這是 knowledge.js 的其中一個 provider；對外工具名是中性的 save_note / search_notes：
// - sendToWiki（save_note）  → POST /api/inbox：丟純文字進去，MyWiki 背景抽實體、建決策頁、偵測衝突
// - askWiki（search_notes）  → POST /api/ask：RAG 問答，回答案＋來源 citations
const BASE_URL = (process.env.MYWIKI_BASE_URL || "").replace(/\/+$/, "");
const API_KEY = process.env.MYWIKI_API_KEY || "";

export const mywikiConfigured = Boolean(BASE_URL && API_KEY);

async function api(path, body, timeoutMs) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    // 非 JSON 回應（例如 502 頁面），下面用 status 報錯
  }
  if (!res.ok) {
    throw new Error(`MyWiki ${path} 失敗（${res.status}）：${data.error || "未知錯誤"}`);
  }
  return data;
}

// 把一段速記／決策文字送進 MyWiki inbox。回 { documentId, title, status }。
// inbox 收到後立刻回應、pipeline 在 MyWiki 背景跑，所以 timeout 短。
export async function sendToWiki({ title, text }) {
  return api("/api/inbox", { title, text, source: "line" }, 20_000);
}

// 問 MyWiki 知識庫。回 { answer, citations: [{ n, title, page, snippet }] }。
// 要跑 embedding + Claude 作答，給長一點的 timeout。
export async function askWiki(question) {
  return api("/api/ask", { question }, 90_000);
}
