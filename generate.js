// ScrubUp AI helper (runs on Vercel, free plan).
// Turns a student's photo, PDF or note into a short revision summary + practice questions.
// The API key lives in Vercel settings (Environment Variables), never inside the app.
//
// Settings in Vercel → Project → Settings → Environment Variables:
//   AI_PROVIDER     "gemini" (default) or "claude"
//   GEMINI_API_KEY  your key from Google AI Studio
//   GEMINI_MODEL    optional, default "gemini-3.5-flash-lite"
//   ANTHROPIC_API_KEY  only if AI_PROVIDER is "claude"
//   CLAUDE_MODEL    optional, default "claude-haiku-5-5"

const MAX_B64 = 4_000_000; // stays under Vercel's ~4.5 MB request limit

const PROMPT = (module, topic) => `You help nursing students in Kenya revise. The attached material is from their ${module} module${topic ? ` (topic: ${topic})` : ""}.
Use ONLY facts found in the material. Do not invent doses or facts. Write in simple, plain English; explain any hard medical word in brackets.
Return ONLY JSON in exactly this shape:
{"summary": ["5 to 8 short revision points"],
 "questions": [
   {"type":"mcq","q":"question","o":["A","B","C","D"],"a":0,"e":"why the answer is right"},
   {"type":"short","q":"exam-style question","m":4,"model":["marking point 1","marking point 2"]}
 ]}
Make 5 "mcq" questions (exactly 4 options each, "a" is the index 0-3 of the correct option) and 3 "short" questions (marks 2-6, one marking point per mark).
If the material is unreadable or is not study material, return {"error":"short reason"}.`;

async function callGemini({ text, file, module, topic }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("The AI key is missing in Vercel settings (GEMINI_API_KEY).");
  const model = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  const parts = [{ text: PROMPT(module, topic) }];
  if (text) parts.push({ text: "MATERIAL:\n" + text });
  if (file) parts.push({ inline_data: { mime_type: file.type, data: file.data } });
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { responseMimeType: "application/json", temperature: 0.3 } })
  });
  const j = await r.json();
  if (r.status === 429) throw new Error("The free AI allowance for today is used up. Try again tomorrow.");
  if (!r.ok) throw new Error(j.error?.message || "The AI service returned an error.");
  return j.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
}

async function callClaude({ text, file, module, topic }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("The AI key is missing in Vercel settings (ANTHROPIC_API_KEY).");
  const content = [];
  if (file && file.type === "application/pdf") content.push({ type: "document", source: { type: "base64", media_type: file.type, data: file.data } });
  else if (file) content.push({ type: "image", source: { type: "base64", media_type: file.type, data: file.data } });
  if (text) content.push({ type: "text", text: "MATERIAL:\n" + text });
  content.push({ type: "text", text: PROMPT(module, topic) });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.CLAUDE_MODEL || "claude-haiku-5-5", max_tokens: 4000, messages: [{ role: "user", content }] })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || "The AI service returned an error.");
  return (j.content || []).map(b => b.text || "").join("");
}

function clean(raw) {
  const s = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  const j = JSON.parse(s);
  if (j.error) return { error: String(j.error) };
  const summary = (Array.isArray(j.summary) ? j.summary : [String(j.summary || "")]).map(String).filter(Boolean).slice(0, 10);
  const questions = (j.questions || []).filter(q =>
    (q.type === "mcq" && q.q && Array.isArray(q.o) && q.o.length === 4 && Number.isInteger(q.a) && q.a >= 0 && q.a < 4) ||
    (q.type === "short" && q.q && Array.isArray(q.model) && q.model.length)
  ).slice(0, 12).map(q => q.type === "mcq"
    ? { type: "mcq", q: String(q.q), o: q.o.map(String), a: q.a, e: String(q.e || "") }
    : { type: "short", q: String(q.q), m: Math.min(10, Math.max(1, +q.m || q.model.length)), model: q.model.map(String).join("\n") });
  return { summary, questions };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  const origin = req.headers.origin || "";
  const host = req.headers.host || "";
  if (origin && !origin.endsWith(host)) return res.status(403).json({ error: "Not allowed." });
  try {
    const { text, file, module = "nursing", topic = "" } = req.body || {};
    if (!text && !file) return res.status(400).json({ error: "Nothing to read." });
    if (file && (!file.data || file.data.length > MAX_B64)) return res.status(413).json({ error: "That file is too big. Send one chapter or one photo at a time." });
    if (text && text.length > 60000) return res.status(413).json({ error: "That note is too long." });
    const provider = (process.env.AI_PROVIDER || "gemini").toLowerCase();
    const raw = provider === "claude" ? await callClaude({ text, file, module, topic }) : await callGemini({ text, file, module, topic });
    const out = clean(raw);
    if (out.error) return res.status(422).json(out);
    if (!out.questions.length) return res.status(422).json({ error: "The AI couldn't make questions from this. Try a clearer photo." });
    return res.status(200).json({ ...out, provider });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Something went wrong." });
  }
}
