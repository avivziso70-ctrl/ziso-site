// Late bot for WhatsApp chats that a person is handling. wa-webhook keeps the customer bot silent for
// wa_config.human_quiet_hours after a phone-app / CRM reply, so when the staff then go quiet nobody answers at all.
// pg_cron job 'wa-late-bot' calls this every 2 minutes (whatsapp/late-bot-cron.sql). Two passes:
//
// 1. LATE ANSWER (Aviv 1.11): the customer's latest live inbound text is 10..60 minutes old, nobody answered and a person
//    had been talking to the customer: answer ONLY if a cheap classifier says it is a simple fixed-fact question.
//    Decisions: wa_events field "late_bot".
//
// 2. HOLDING MESSAGE (Aviv 10.11 "מאשר הודעת החזקה", "מאשר פריסה"; LIVE since v4): the customer's latest live inbound is
//    30 min .. 4 h old, nobody answered and a person had been talking to the customer: one short acknowledgement. Work hours:
//    "אילת או שיר יחזרו אליך בהקדם", otherwise "נחזור אליך הבוקר / מחר בבוקר / ביום ראשון בבוקר". Meeting link only when a Haiku
//    classifier says it is a private customer shopping (no verdict = hold without link). Acks get nothing. Once per chat per
//    Israel day (+6h gap). Marked automatic. Rows: wa_messages source "bot", type "hold", id "hold-<inbound id>" (claimed
//    before sending). Decisions: wa_events "hold_bot" ("hold_bot_dry" on POST {"dry":true}). POST {"test":[texts]} = classifier
//    check only. Kill switch: set HOLD_LIVE false and redeploy, or wa_config.bot_enabled false (stops all bot sends).
//    The CRM inbox counts only human replies (crm_inbox.human_out), so a held chat still shows as waiting for the staff.
//    12.11: supplier files (document/image from sp_supplier_phones, or a "מחירון/קטלוג/price list" document) are skipped;
//    wa-webhook acknowledges them and supplier-wa takes them.
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const GRAPH = "https://graph.facebook.com/v23.0";
const BOT_URL = `${Deno.env.get("SUPABASE_URL")}/functions/v1/ziso-bot`;
const MIN_AGE_MIN = 10, MAX_AGE_MIN = 60, HISTORY_TURNS = 30;
const HOLD_LIVE = true;
const HOLD_MIN_AGE_MIN = 30, HOLD_MAX_AGE_MIN = 240, HOLD_DAILY_CAP = 60, HOLD_GAP_HOURS = 6;
const HOLD_TYPES = ["text", "button", "interactive", "image", "video", "document", "audio", "location"];
const META_TYPES = "(reaction,edit,revoke,unsupported,sticker,contacts)";
const PEGISHA = "https://www.zisoceramics.com/pegisha.html";
const PRICELIST_WORDS = /מחירון|קטלוג|price\s*-?\s*list|pricelist|catalog/i;
const DISCLOSURE = "היי, כאן העוזר הדיגיטלי (אוטומטי) של זיסו קרמיקה. הצוות רואה את השיחה ויחזור אליך בשעות הפעילות, ובינתיים אשמח לעזור.";
const DISCLOSURE_SHORT = "היי, כאן העוזר הדיגיטלי (אוטומטי) של זיסו קרמיקה.";
const ESCALATE = /שבור|שבר|טעות|לא מה שהזמנתי|ביטול|לבטל|זיכוי|בושה|חלודה|חוק המכר|תלונה|כתב כמויות|רשימת כמויות/;
const AD_TAG = /\s*\(([a-z0-9-]{2,12})\)\s*$/i;
const CLASSIFIER = `You classify ONE WhatsApp message from a customer of a tile and bathroom showroom (Ziso Ceramics, Tirat Carmel, Israel).
Answer {"simple":true} ONLY if the customer's latest message is a short factual question whose answer is a fixed fact about the business: which city or where the showroom is, the address, how to get there, parking, opening hours, whether it is open today, the phone number.
Everything else is {"simple":false}: prices or quotes, product availability or stock, delivery, installation, order or payment status, complaints, cancellation, asking for a specific person, scheduling a meeting, photos, thanks/ok/emoji-only messages, anything personal, medical, legal, or unclear.
Reply with the JSON only.`;
const HOLD_CLASSIFIER = `You look at the latest WhatsApp message a customer sent to a tile and bathroom showroom (Ziso Ceramics, Tirat Carmel, Israel) while the staff have not answered yet. Reply with JSON only: {"reply":true|false,"meeting":true|false}.
"reply" is true when the message still waits for an answer from the business: a question, a request, an answer to a staff question (a number, a size, yes/no, a choice), details, a photo, a voice note or a file, "are you there?". It is false when nothing needs answering: thanks, ok, emoji only, "got it", "see you", "I'm on my way", "I sent it", a goodbye, or the customer says they will get back to us.
"meeting" is true only when the writer looks like a private customer planning or shopping for tiles, bathroom, kitchen or renovation products (asking about products, prices, availability, design, sizes, a quote, a visit), so an invitation to a free design meeting in the showroom fits. It is false for an existing order, delivery, installation, payment, invoice or receipt, a complaint or a fault, a supplier, installer, driver or contractor talking shop, a personal chat, or anything unclear.`;

const countRows = async (q: any) => ((await q) as { count: number | null }).count ?? 0;
// 16.11: both passes stay silent to any number in sp_supplier_phones, whatever the message type (standing rule: the
// customer bot never answers suppliers; a supplier got a hold message on 15.11).
const supKey = (p: unknown) => String(p || "").replace(/\D/g, "").replace(/^972/, "").replace(/^0+/, "");
const isSupplier = async (phone: string) =>
  (await countRows(db.from("sp_supplier_phones").select("phone_key", { count: "exact", head: true }).eq("phone_key", supKey(phone)))) > 0;

async function haiku(system: string, user: string, maxTokens: number) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`classifier ${r.status}: ${String(j?.error?.message || "").slice(0, 120)}`);
  return (j?.content || []).filter((b: any) => b.type === "text").map((b: any) => String(b.text || "")).join("");
}

async function simpleFactual(text: string, context: string): Promise<boolean> {
  const out = await haiku(CLASSIFIER, `Recent chat (oldest first):\n${context}\n\nCustomer's latest message:\n${text}`, 20);
  return /"simple"\s*:\s*true/.test(out);
}

// No verdict (the model sometimes returns nothing on short or ambiguous messages): hold without the meeting line.
async function holdClassify(text: string, context: string): Promise<{ reply: boolean; meeting: boolean; verdict: string }> {
  const out = await haiku(HOLD_CLASSIFIER, `Recent chat (oldest first):\n${context || "(none)"}\n\nCustomer's latest message:\n${text}\n\nAnswer with the JSON object only.`, 150);
  if (!/"reply"\s*:\s*(true|false)/.test(out)) return { reply: true, meeting: false, verdict: "none" };
  return { reply: /"reply"\s*:\s*true/.test(out), meeting: /"meeting"\s*:\s*true/.test(out), verdict: "haiku" };
}

async function sendText(cfg: any, to: string, body: string) {
  const r = await fetch(`${GRAPH}/${cfg.phone_number_id}/messages`, {
    method: "POST", headers: { Authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`send: ${j?.error?.message || r.status}`);
  return (j.messages?.[0]?.id as string) || `bot-${crypto.randomUUID()}`;
}

async function decide(cfg: any, m: any, summary: string[]) {
  const mark = (decision: string, extra: Record<string, unknown> = {}) =>
    db.from("wa_events").insert({ field: "late_bot", payload: { message_id: m.id, decision, ...extra } });
  const phone = m.phone as string;
  const text = String(m.text || "");
  if ((cfg.no_bot_phones || []).includes(phone)) { await mark("skip:staff"); return; }
  if (await isSupplier(phone)) { await mark("skip:supplier"); return; }
  const waId = "972" + phone.slice(1);
  if (!AD_TAG.test(text)) {
    const { data: c } = await db.from("wa_contacts").select("saved").eq("phone", phone).maybeSingle();
    if (c?.saved) { await mark("skip:saved"); return; }
    if (await countRows(db.from("wa_messages").select("id", { count: "exact", head: true }).eq("phone", phone).eq("source", "history"))) { await mark("skip:history"); return; }
  }
  const dayStart = new Date(Date.now() - 24 * 3600_000).toISOString();
  if (await countRows(db.from("wa_messages").select("id", { count: "exact", head: true }).eq("source", "bot").gte("ts", dayStart)) >= (cfg.bot_daily_cap || 300)) { summary.push("cap"); return; }
  if (await countRows(db.from("wa_messages").select("id", { count: "exact", head: true }).eq("source", "bot").eq("phone", phone).gte("ts", dayStart)) >= (cfg.bot_per_phone_cap || 25)) { await mark("skip:phone-cap"); return; }
  const monthAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
  const { data: rows } = await db.from("wa_messages").select("id, dir, text, ts").eq("phone", phone).neq("id", m.id).lte("ts", m.ts)
    .gte("ts", monthAgo).order("ts", { ascending: false }).limit(HISTORY_TURNS);
  const turns = (rows || []).reverse().map((r: any) => ({ role: r.dir === "in" ? "user" : "assistant", content: String(r.text || "").replace(AD_TAG, "").slice(0, 1500) }));
  const context = turns.slice(-6).map((t: any) => `${t.role === "user" ? "Customer" : "Business"}: ${t.content}`).join("\n").slice(0, 2500);
  let simple = false;
  try { simple = await simpleFactual(text.replace(AD_TAG, ""), context); }
  catch (e) { await mark("error:classifier", { error: String((e as Error).message).slice(0, 200) }); return; }
  if (!simple) { await mark("skip:not-simple"); return; }
  const r = await fetch(BOT_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`, "x-internal-channel": "whatsapp", "content-type": "application/json" },
    body: JSON.stringify({ channel: "whatsapp", history: turns, message: text.replace(AD_TAG, "") || "שלום" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || typeof j.reply !== "string") { await mark("error:bot", { status: r.status }); return; }
  if (/₪|ש"ח|שקל|מחיר/.test(j.reply)) { await mark("skip:price-in-reply"); return; }
  const priorBot = await countRows(db.from("wa_messages").select("id", { count: "exact", head: true }).eq("source", "bot").eq("phone", phone).gte("ts", monthAgo));
  const reply = (priorBot || /בוט|העוזר הדיגיטלי|אוטומטי/.test(j.reply) ? "" : DISCLOSURE + "\n\n") + j.reply;
  let sentId: string;
  try { sentId = await sendText(cfg, waId, reply); }
  catch (e) { await mark("error:send", { error: String((e as Error).message).slice(0, 200) }); return; }
  await db.from("wa_messages").upsert({
    id: sentId, ts: new Date().toISOString(), phone, dir: "out", type: "text", text: reply, name: m.name, source: "bot", biz_phone: m.biz_phone,
    raw: { bot: true, late: true, in_reply_to: m.id, usage: j.usage ?? null },
  }, { onConflict: "id", ignoreDuplicates: true });
  await mark("answered");
  summary.push("answered");
}

async function latePass(cfg: any, summary: string[]) {
  const from = new Date(Date.now() - MAX_AGE_MIN * 60_000).toISOString();
  const to = new Date(Date.now() - MIN_AGE_MIN * 60_000).toISOString();
  const { data: cands } = await db.from("wa_messages").select("id, phone, text, ts, name, biz_phone, type")
    .eq("dir", "in").eq("source", "live").eq("type", "text").gte("ts", from).lte("ts", to).like("phone", "0%").order("ts", { ascending: true }).limit(50);
  const latest = new Map<string, any>();
  for (const c of cands || []) latest.set(c.phone, c);
  for (const m of latest.values()) {
    try {
      if (await countRows(db.from("wa_messages").select("id", { count: "exact", head: true }).eq("phone", m.phone).eq("dir", "in").gt("ts", m.ts))) continue;
      if (await countRows(db.from("wa_events").select("id", { count: "exact", head: true }).eq("field", "late_bot").contains("payload", { message_id: m.id }))) continue;
      if (await countRows(db.from("wa_messages").select("id", { count: "exact", head: true }).eq("phone", m.phone).eq("dir", "out").gt("ts", m.ts))) continue;
      const quietSince = new Date(new Date(m.ts).getTime() - (cfg.human_quiet_hours || 12) * 3600_000).toISOString();
      const human = await countRows(db.from("wa_messages").select("id", { count: "exact", head: true }).eq("phone", m.phone).eq("dir", "out").in("source", ["phone-app", "crm"]).gte("ts", quietSince).lt("ts", m.ts));
      if (!human) continue;
      await decide(cfg, m, summary);
    } catch (e) {
      await db.from("wa_events").insert({ field: "bot_error", payload: { error: "late-bot: " + String((e as Error).message).slice(0, 300) } });
    }
  }
  return latest.size;
}

const IL_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" });
function ilTime(d = new Date()) {
  const o: Record<string, string> = {};
  for (const p of IL_FMT.formatToParts(d)) o[p.type] = p.value;
  return { dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(o.weekday), minutes: Number(o.hour) * 60 + Number(o.minute), day: `${o.year}-${o.month}-${o.day}` };
}
function whenBack(): { open: boolean; line: string } {
  const { dow, minutes } = ilTime();
  const openFrom = 8 * 60, closeAt = dow === 5 ? 13 * 60 + 30 : 18 * 60;
  if (dow <= 5 && minutes >= openFrom && minutes < closeAt) return { open: true, line: "אילת או שיר יחזרו אליך בהקדם." };
  if (dow <= 5 && minutes < openFrom) return { open: false, line: "נחזור אליך הבוקר, אחרי 08:00." };
  if (dow >= 5) return { open: false, line: "נחזור אליך ביום ראשון בבוקר." };
  return { open: false, line: "נחזור אליך מחר בבוקר." };
}
function holdText(meeting: boolean, priorBot: number) {
  const body = `קיבלנו את ההודעה שלך 🙏 ${whenBack().line}` + (meeting ? `\nרוצים בינתיים לקבוע פגישת עיצוב חינם באולם? ${PEGISHA}` : "");
  return priorBot ? body + "\n(הודעה אוטומטית)" : DISCLOSURE_SHORT + "\n\n" + body;
}

const ACK_WORDS = new Set(["תודה", "אוקי", "אוקיי", "או", "קיי", "ok", "okay", "okk", "k", "thanks", "thank", "you", "thx", "סבבה", "בסדר", "גמור", "מעולה", "יופי", "מצוין", "מצויין", "בשמחה", "אין", "בעיה", "סגור", "הבנתי", "קיבלתי", "נהדר", "אחלה", "מושלם", "טוב", "בהצלחה", "נתראה", "להתראות", "ביי", "יאללה", "נייס", "מגניב", "אמן", "מקסים"]);
const FILLER = new Set(["רבה", "לך", "לכם", "מאוד", "ממש", "באמת", "אילת", "איילת", "שיר", "אביב", "אחי", "יקירה", "יקירי", "מותק", "הרבה", "על", "העזרה", "הזמן", "המענה", "התשובה", "השירות", "ההתייחסות", "גם"]);
const ACK_PHRASES = new Set(["לילה טוב", "שבת שלום", "שבוע טוב", "סופש נעים", "יום טוב", "המשך יום טוב", "המשך יום נעים", "חג שמח"]);
function isAck(text: string) {
  const norm = text.replace(AD_TAG, "").toLowerCase()
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Join_Control}\p{Variation_Selector}]/gu, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (!norm) return true;
  if (ACK_PHRASES.has(norm)) return true;
  const words = norm.split(" ").filter((w) => !FILLER.has(w));
  return words.length <= 4 && words.every((w) => ACK_WORDS.has(w));
}

async function holdDecide(cfg: any, m: any, summary: string[], dry: boolean, dryOut: any[]) {
  const phone = m.phone as string;
  const p4 = phone.slice(-4);
  const rehearsal = dry || !HOLD_LIVE;
  const field = rehearsal ? "hold_bot_dry" : "hold_bot";
  const mark = (decision: string, extra: Record<string, unknown> = {}) =>
    db.from("wa_events").insert({ field, payload: { message_id: m.id, phone, decision, ...extra } });
  const note = (decision: string, extra: Record<string, unknown> = {}) => { if (dry) dryOut.push({ p4, age_min: Math.round((Date.now() - new Date(m.ts).getTime()) / 60_000), type: m.type, decision, ...extra }); };

  if ((cfg.no_bot_phones || []).includes(phone) || !/^0\d{8,9}$/.test(phone)) return;
  if (await isSupplier(phone)) return;
  if ((m.type === "document" || m.type === "image") && PRICELIST_WORDS.test(String(m.text || "") + " " + String(m.fname || ""))) return;
  if (await countRows(db.from("wa_messages").select("id", { count: "exact", head: true }).eq("phone", phone).eq("dir", "in").gt("ts", m.ts).not("type", "in", META_TYPES))) return;
  if (await countRows(db.from("wa_messages").select("id", { count: "exact", head: true }).eq("phone", phone).eq("dir", "out").gt("ts", m.ts))) return;
  if (await countRows(db.from("wa_events").select("id", { count: "exact", head: true }).eq("field", field).contains("payload", { message_id: m.id }))) return;
  const quietSince = new Date(new Date(m.ts).getTime() - (cfg.human_quiet_hours || 12) * 3600_000).toISOString();
  if (!await countRows(db.from("wa_messages").select("id", { count: "exact", head: true }).eq("phone", phone).eq("dir", "out").in("source", ["phone-app", "crm"]).gte("ts", quietSince).lt("ts", m.ts))) return;

  const { data: lastHold } = await db.from("wa_messages").select("ts").eq("phone", phone).eq("type", "hold").order("ts", { ascending: false }).limit(1);
  if (lastHold?.length) {
    const t = new Date(lastHold[0].ts);
    if (Date.now() - t.getTime() < HOLD_GAP_HOURS * 3600_000 || ilTime(t).day === ilTime().day) { await mark("skip:held-today"); note("skip:held-today"); return; }
  }
  const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
  if (await countRows(db.from("wa_messages").select("id", { count: "exact", head: true }).eq("type", "hold").gte("ts", dayAgo)) >= HOLD_DAILY_CAP) { summary.push("hold-cap"); note("skip:daily-cap"); return; }
  if (await countRows(db.from("wa_messages").select("id", { count: "exact", head: true }).eq("source", "bot").eq("phone", phone).gte("ts", dayAgo)) >= (cfg.bot_per_phone_cap || 25)) { await mark("skip:phone-cap"); note("skip:phone-cap"); return; }

  const text = String(m.text || "");
  if (isAck(text)) { await mark("skip:ack"); note("skip:ack"); return; }
  const monthAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
  const { data: rows } = await db.from("wa_messages").select("dir, text, ts").eq("phone", phone).neq("id", m.id).neq("source", "history")
    .lte("ts", m.ts).gte("ts", monthAgo).order("ts", { ascending: false }).limit(8);
  const context = (rows || []).reverse().map((r: any) => `${r.dir === "in" ? "Customer" : "Business"}: ${String(r.text || "").replace(AD_TAG, "").slice(0, 300)}`).join("\n").slice(0, 2500);
  let reply = true, meeting = false, verdict = "default";
  try { ({ reply, meeting, verdict } = await holdClassify(text.replace(AD_TAG, "") || `[${m.type}]`, context)); }
  catch (e) { await db.from("wa_events").insert({ field: "bot_error", payload: { error: "hold-bot classifier: " + String((e as Error).message).slice(0, 200) } }); }
  if (!reply) { await mark("skip:no-reply-needed"); note("skip:no-reply-needed"); return; }
  if (ESCALATE.test(text)) meeting = false;
  const priorBot = await countRows(db.from("wa_messages").select("id", { count: "exact", head: true }).eq("source", "bot").eq("phone", phone).gte("ts", monthAgo));
  const body = holdText(meeting, priorBot);
  const { open } = whenBack();
  if (rehearsal) { await mark("dry:would-send", { meeting, open, verdict }); note("would-send", { meeting, open, verdict, text: body }); return; }

  const rowId = `hold-${m.id}`;
  const raw = { bot: true, hold: true, in_reply_to: m.id, meeting, open, verdict };
  const { data: claimed } = await db.from("wa_messages").upsert({
    id: rowId, ts: new Date().toISOString(), phone, dir: "out", type: "hold", text: body, name: m.name, source: "bot", biz_phone: m.biz_phone, raw: { ...raw, pending: true },
  }, { onConflict: "id", ignoreDuplicates: true }).select("id");
  if (!claimed?.length) return;
  try {
    const wamid = await sendText(cfg, "972" + phone.slice(1), body);
    await db.from("wa_messages").update({ ts: new Date().toISOString(), raw: { ...raw, wamid } }).eq("id", rowId);
    await mark("sent", { meeting, open, verdict });
    summary.push("hold");
  } catch (e) {
    await db.from("wa_messages").delete().eq("id", rowId);
    await mark("error:send", { error: String((e as Error).message).slice(0, 200) });
  }
}

async function holdPass(cfg: any, summary: string[], dry: boolean, dryOut: any[]) {
  const from = new Date(Date.now() - HOLD_MAX_AGE_MIN * 60_000).toISOString();
  const to = new Date(Date.now() - HOLD_MIN_AGE_MIN * 60_000).toISOString();
  const { data: cands } = await db.from("wa_messages").select("id, phone, text, ts, name, biz_phone, type, fname:raw->document->>filename")
    .eq("dir", "in").eq("source", "live").in("type", HOLD_TYPES).gte("ts", from).lte("ts", to).like("phone", "0%").order("ts", { ascending: true }).limit(100);
  const latest = new Map<string, any>();
  for (const c of cands || []) latest.set(c.phone, c);
  for (const m of latest.values()) {
    try { await holdDecide(cfg, m, summary, dry, dryOut); }
    catch (e) { await db.from("wa_events").insert({ field: "bot_error", payload: { error: "hold-bot: " + String((e as Error).message).slice(0, 300) } }); }
  }
  return latest.size;
}

async function run(dry: boolean) {
  const summary: string[] = [];
  const dryOut: any[] = [];
  const { data: cfg } = await db.from("wa_config").select("*").eq("id", 1).maybeSingle();
  if (!cfg?.bot_enabled || !cfg?.token || !cfg?.phone_number_id) return { skipped: "bot off or not connected" };
  const late = dry ? 0 : await latePass(cfg, summary);
  const held = await holdPass(cfg, summary, dry, dryOut);
  return dry ? { dry: true, checked: held, hold_live: HOLD_LIVE, decisions: dryOut } : { checked: late, hold_checked: held, hold_live: HOLD_LIVE, summary };
}

Deno.serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") return new Response("ok");
  let dry = false;
  if (req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    dry = b?.dry === true;
    if (Array.isArray(b?.test)) {
      const out: any[] = [];
      for (const t of b.test.slice(0, 25)) {
        const text = String(t);
        if (isAck(text)) { out.push({ text, ack: true }); continue; }
        try { out.push({ text, ...(await holdClassify(text, "")) }); } catch (e) { out.push({ text, error: String((e as Error).message) }); }
      }
      return Response.json({ test: out });
    }
  }
  return Response.json(await run(dry));
});
