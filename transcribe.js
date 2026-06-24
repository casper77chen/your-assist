// Phase 12：語音轉文字（LINE 語音訊息 → OpenAI Whisper → 文字進正常對話流程）
// 共用 Casper 在 MyWiki 用的 OPENAI_API_KEY；沒設就回報語音功能未開。
const apiKey = process.env.OPENAI_API_KEY;

export const transcribeConfigured = Boolean(apiKey);

/**
 * 把語音 buffer 轉成文字。LINE 語音是 m4a（audio/x-m4a 或 audio/aac）。
 * @param {Buffer} buffer
 * @param {string} mediaType 例如 "audio/x-m4a"
 * @returns {Promise<string>} 轉錄文字
 */
export async function transcribe(buffer, mediaType) {
  if (!transcribeConfigured) throw new Error("缺 OPENAI_API_KEY，語音功能未開");
  const form = new FormData();
  // 副檔名要對，Whisper 用它判斷格式
  const ext = mediaType.includes("aac") ? "aac" : "m4a";
  form.append("file", new Blob([buffer], { type: mediaType }), `voice.${ext}`);
  form.append("model", "whisper-1");
  form.append("language", "zh"); // Casper 講中文（夾英文詞 Whisper 也處理得來）
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Whisper 轉錄失敗（${res.status}）：${data.error?.message || "未知錯誤"}`);
  }
  return (data.text || "").trim();
}
