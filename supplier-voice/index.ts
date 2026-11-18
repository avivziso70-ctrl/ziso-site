// supplier-voice: every WhatsApp voice note a SUPPLIER sends us is transcribed and understood (Aviv 18.11.2026:
// "תתמלל תבין תמיד מה הספקים אומרים לנו"). Gemini, where it is better than Claude for audio (Aviv 17.11).
// Called every 5 minutes by pg_cron (job supplier-voice) with an empty body. It acts only on inbound audio rows in
// wa_messages from a number in sp_supplier_phones, so a customer's or staff member's voice is never sent anywhere.
// Each note is done once: the transcript and a short summary go into wa_messages.raw (transcript, voice_summary) and the
// text column becomes "[audio] 🎤 <transcript>" so every screen that shows the chat shows the words. When the supplier
// asks for something or changes prices, terms or dates, the office gets one crm_tasks row.
import { createClient } from "npm:@supabase/supabase-js@2";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const GRAPH = "https://graph.facebook.com/v23.0";
const MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-flash-latest";
const PROMPT = `זו הודעה קולית בוואטסאפ מספק של זיסו קרמיקה (אולם קרמיקה וכלים סניטריים בטירת כרמל). הספק: SUPPLIER.
החזר JSON בלבד, בלי טקסט נוסף:
{"transcript": "תמלול מדויק בעברית, מילה במילה", "summary": "משפט או שניים: מה הספק אומר ומה הוא מבקש", "action": true/false, "action_text": "מה צריך לעשות אצלנו, אם בכלל"}
action=true רק אם הספק מבקש משהו, שואל שאלה, או מודיע על שינוי מחיר, תנאים, מועד אספקה, חוסר במלאי או ביטול.
אם חלק לא ברור, כתוב [לא ברור] ואל תנחש.`;

async function one(m: any, supplier: string, token: string) {
  const auth = { Authorization: `Bearer ${token}` };
  const meta = await (await fetch(`${GRAPH}/${m.raw.audio.id}`, { headers: auth })).json().catch(() => ({}));
  if (!meta?.url) throw new Error("media url: " + (meta?.error?.message || "none"));
  const audio = new Uint8Array(await (await fetch(meta.url, { headers: auth })).arrayBuffer());
  let b64 = ""; for (let i = 0; i < audio.length; i += 0x8000) b64 += String.fromCharCode(...audio.subarray(i, i + 0x8000));
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": Deno.env.get("GEMINI_API_KEY")! },
    body: JSON.stringify({ contents: [{ parts: [{ text: PROMPT.replace("SUPPLIER", supplier) }, { inline_data: { mime_type: String(m.raw.audio.mime_type || "audio/ogg").split(";")[0], data: btoa(b64) } }] }],
      generationConfig: { temperature: 0.1, responseMimeType: "application/json" } }),
  });
  const g = await r.json().catch(() => ({}));
  const out = JSON.parse(g?.candidates?.[0]?.content?.parts?.[0]?.text || "null");
  if (!out?.transcript) throw new Error("gemini " + r.status);
  return out as { transcript: string; summary?: string; action?: boolean; action_text?: string };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const since = new Date(Date.now() - 25 * 864e5).toISOString();   // WhatsApp keeps media about 30 days
  const { data: rows } = await db.from("wa_messages").select("id, ts, phone, name, raw, text").eq("dir", "in").eq("type", "audio")
    .gte("ts", since).is("raw->>transcript", null).order("ts", { ascending: true }).limit(40);
  const { data: phones } = await db.from("sp_supplier_phones").select("phone_key, supplier_id, sp_suppliers(name)");
  const sup = new Map((phones || []).map((p: any) => [String(p.phone_key), { id: p.supplier_id, name: p.sp_suppliers?.name || "ספק" }]));
  const todo = (rows || []).filter((m: any) => sup.has(String(m.phone || "").slice(-9)) && Number(m.raw?.voice_tries || 0) < 3 && m.raw?.audio?.id).slice(0, 5);
  if (!todo.length) return Response.json({ ok: true, done: 0 });
  const { data: cfg } = await db.from("wa_config").select("token").eq("id", 1).maybeSingle();
  const res: unknown[] = [];
  for (const m of todo) {
    const s = sup.get(String(m.phone).slice(-9))!;
    try {
      const o = await one(m, s.name, cfg?.token || "");
      await db.from("wa_messages").update({ text: "[audio] 🎤 " + o.transcript.slice(0, 3000), raw: { ...m.raw, transcript: o.transcript, voice_summary: o.summary || null, voice_action: o.action ? (o.action_text || o.summary) : null, transcribed_at: new Date().toISOString() } }).eq("id", m.id);
      if (o.action) {
        await db.from("crm_tasks").insert({ text: `🎤 הודעה קולית מ${s.name}: ${o.summary || ""}${o.action_text ? " · לטיפול: " + o.action_text : ""} (התמלול המלא בצ'אט הוואטסאפ של הספק)`.slice(0, 900), due: new Date().toISOString(), by: "הודעה קולית מספק" });
      }
      res.push({ id: m.id, ok: true, action: !!o.action });
    } catch (e) {
      await db.from("wa_messages").update({ raw: { ...m.raw, voice_tries: Number(m.raw?.voice_tries || 0) + 1, voice_error: String((e as Error).message).slice(0, 200) } }).eq("id", m.id);
      res.push({ id: m.id, ok: false, error: String((e as Error).message).slice(0, 200) });
    }
  }
  return Response.json({ ok: true, done: res.length, res });
});
