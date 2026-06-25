// 知識庫 provider 抽象層（M7）。
//
// 框架把「決策日誌／個人知識庫」做成可插拔 provider，一個部署**二選一**：
//   - mywiki   ：接獨立部署的 MyWiki（capture + RAG 問答；canSearch=true）
//   - obsidian ：寫進 Obsidian vault（透過 vault 同步的雲端後端；v1 只 capture，canSearch=false）
//   - none     ：兩個都沒設 → 知識庫能力整個關閉（工具不註冊、prompt 不提、路由降路）
//
// 上層（assistant.js / system-prompt.js / connectors.js）只認本檔的介面，不直接碰 mywiki.js / obsidian.js。
// 工具對外名稱也中性化：save_note（存）/ search_notes（查），不綁特定產品。
//
// 選擇邏輯：env `KNOWLEDGE_PROVIDER` 明指優先（但該 provider 真的設好憑證才算數）；
// 沒指定就自動取「第一個設定好的」（mywiki 優先），都沒有就 null。
import { mywikiConfigured, sendToWiki, askWiki } from "./mywiki.js";
import { obsidianConfigured, saveToObsidian } from "./obsidian.js";

const PROVIDERS = {
  mywiki: {
    label: "MyWiki",
    configured: () => mywikiConfigured,
    canSearch: true,
    save: ({ title, text }) => sendToWiki({ title, text }),
    search: (question) => askWiki(question),
  },
  obsidian: {
    label: "Obsidian",
    configured: () => obsidianConfigured,
    canSearch: false, // v1 只做 capture，查詢之後再說
    save: ({ title, text }) => saveToObsidian({ title, text }),
    search: () => {
      throw new Error("Obsidian provider 目前只支援存筆記，還不能查詢");
    },
  },
};

const ORDER = ["mywiki", "obsidian"]; // 自動挑選時的優先序

function pickProvider() {
  const explicit = (process.env.KNOWLEDGE_PROVIDER || "").trim().toLowerCase();
  if (explicit && PROVIDERS[explicit] && PROVIDERS[explicit].configured()) {
    return explicit;
  }
  return ORDER.find((k) => PROVIDERS[k].configured()) || null;
}

const active = pickProvider();
const provider = active ? PROVIDERS[active] : null;

export const knowledgeProvider = active; // "mywiki" | "obsidian" | null
export const knowledgeConfigured = Boolean(provider);
export const knowledgeLabel = provider ? provider.label : "";
export const knowledgeCanSearch = Boolean(provider && provider.canSearch);

// 存一筆筆記／決策進知識庫。回傳 provider 原生結果（mywiki：{documentId,title,status}）。
export async function saveNote({ title, text }) {
  if (!provider) throw new Error("沒有設定知識庫 provider");
  return provider.save({ title, text });
}

// 查知識庫。只有 canSearch 的 provider 支援。回傳 provider 原生結果（mywiki：{answer,citations}）。
export async function searchNotes(question) {
  if (!provider) throw new Error("沒有設定知識庫 provider");
  if (!provider.canSearch) throw new Error(`${provider.label} 目前不支援查詢`);
  return provider.search(question);
}
