// Obsidian vault provider（M7，骨架）。
//
// Obsidian 是本機 markdown vault，沒有雲端 API；雲端 bot 不能直接寫到使用者的 vault。
// 唯一可行路徑＝透過 vault 同步所掛的「雲端後端」寫 .md 檔，再由使用者本機 Obsidian 同步回來：
//   - Google Drive（傾向：框架已有 Google OAuth，可直接寫進 vault 的 Drive 資料夾）
//   - GitHub（Obsidian Git 外掛；bot commit md，使用者端 pull）
//   - Dropbox（需另接一套 OAuth）
//
// ⚠️ 同步後端尚未拍板，故此檔目前是骨架：相關 env 未定義前 obsidianConfigured = false，
//    knowledge.js 不會選到它、能力不會啟用。後端定案後，在這裡：
//    ① 依後端所需 env 計算 obsidianConfigured；② 實作 saveToObsidian（組 markdown → 寫進 vault）。
//
// v1 範圍：只做 capture（把筆記寫進 vault）。查詢（在 vault 內全文搜尋）留到 v2。

// 後端拍板前一律視為未設定。定案後改成例如：
//   export const obsidianConfigured = Boolean(calendarConfigured && process.env.OBSIDIAN_VAULT_FOLDER_ID);
export const obsidianConfigured = false;

// 把一筆筆記寫進 Obsidian vault（v1）。回 { path } 之類。
// 預期作法（待實作）：用標題＋日期組檔名，正文組成 markdown（YAML frontmatter + 內文），
// 透過選定的同步後端寫進 vault 的指定資料夾（例如 "Inbox/"）。
export async function saveToObsidian({ title, text }) {
  throw new Error("Obsidian provider 尚未實作（等同步後端拍板：Google Drive / GitHub / Dropbox）");
}
