// HTTP endpoint for the site chat widget (Supabase Edge Function "ziso-bot", verify_jwt off: the site is public).
// POST {session, message, page} -> {session, reply}. The conversation lives in chat_sessions/chat_messages so the
// widget sends only the new message. Limits: 40 messages per session, 60 per IP per hour, 1000 chars per message.
// Secrets: ANTHROPIC_API_KEY (Aviv sets it in the Supabase dashboard). Supabase URL/key are injected by the platform.
// Internal WhatsApp route (wa-webhook only): header "x-internal-channel: whatsapp" + "authorization: Bearer <service role key>",
// body {channel:"whatsapp", history, message} -> {reply, lead, usage}. No rows are written here; see whatsappTurn.
import { createClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@0.90.0";
import { cleanPhone, runTurn, type Turn } from "./bot.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const ORIGINS = new Set(["https://www.zisoceramics.com", "https://zisoceramics.com", "http://localhost:8080", "http://127.0.0.1:8080"]);
const MAX_PER_SESSION = 40, MAX_PER_IP_HOUR = 60, MAX_CHARS = 1000;
// Business rules edited in SQL (table bot_settings, id 1): extra_rules for every channel, wa_rules for WhatsApp only.
let rulesCache: { at: number; all: string; wa: string } | null = null;
async function extraRules(channel: "site" | "whatsapp") {
  if (!rulesCache || Date.now() - rulesCache.at > 60_000) {
    const { data } = await db.from("bot_settings").select("extra_rules, wa_rules").eq("id", 1).maybeSingle();
    rulesCache = { at: Date.now(), all: data?.extra_rules || "", wa: data?.wa_rules || "" };
  }
  return [rulesCache.all, channel === "whatsapp" ? rulesCache.wa : ""].filter(Boolean).join("\n");
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
// Visitors are counted by a salted hash of the IP, never the IP itself (data minimization).
const ipHash = async (req: Request) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode((Deno.env.get("CHAT_IP_SALT") || "ziso") + "|" + (req.headers.get("x-forwarded-for") || "").split(",")[0].trim())));

function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return { "access-control-allow-origin": ORIGINS.has(o) ? o : "https://www.zisoceramics.com", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, OPTIONS", "vary": "origin", "content-type": "application/json; charset=utf-8" };
}
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors(req) });
// Internal WhatsApp route (wa-webhook calls it; never browsers). Stateless on purpose: the WhatsApp thread keeps the
// conversation in wa_messages (so the bot also sees what Eilat/Shir answered from the phone app), writes the lead,
// enforces caps and the human-quiet rule. Body {channel:"whatsapp", history:[{role,content}], message, phone?, name?, first?}.
async function whatsappTurn(req: Request, body: { history?: unknown; message: string; phone?: string; name?: string; first?: boolean }) {
  const auth = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!auth || auth !== Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) return json(req, { error: "auth" }, 401);
  const history: Turn[] = (Array.isArray(body.history) ? body.history : [])
    .filter((t: any) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && t.content.trim())
    .slice(-MAX_PER_SESSION * 2).map((t: any) => ({ role: t.role, content: t.content.slice(0, MAX_CHARS * 2) }));
  const phone = cleanPhone((body.phone || "").toString()) || undefined;
  const name = (body.name || "").toString().slice(0, 80) || undefined;
  const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
  try {
    const r = await runTurn(client, history, body.message, "whatsapp", { phone, name, first: !!body.first, extra: await extraRules("whatsapp") });
    return json(req, { reply: r.text, lead: r.lead, usage: r.usage });
  } catch (e) { console.error("anthropic", e); return json(req, { error: "anthropic" }, 502); }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "method" }, 405);
  if (!Deno.env.get("ANTHROPIC_API_KEY")) return json(req, { error: "offline", reply: "הצ'אט עדיין לא פעיל. אפשר לכתוב לנו בוואטסאפ 050-4770040." }, 503);
  let body: { session?: string; message?: string; page?: string; channel?: string; history?: unknown; phone?: string; name?: string; first?: boolean };
  try { body = await req.json(); } catch { return json(req, { error: "bad json" }, 400); }
  const message = (body.message || "").toString().trim().slice(0, MAX_CHARS);
  if (!message) return json(req, { error: "empty" }, 400);
  if (body.channel === "whatsapp" || req.headers.get("x-internal-channel") === "whatsapp") return whatsappTurn(req, { ...body, message });
  const ip = await ipHash(req);

  // Per-IP limit before touching the model.
  const { count: ipCount } = await db.from("chat_messages").select("id", { count: "exact", head: true })
    .eq("role", "user").eq("ip_hash", ip).gte("created_at", new Date(Date.now() - 3600_000).toISOString());
  if ((ipCount ?? 0) >= MAX_PER_IP_HOUR) return json(req, { error: "rate", reply: "הגענו למכסת ההודעות לשעה. אפשר להמשיך בוואטסאפ 050-4770040." }, 429);

  // Session: reuse when the id is a real open session, otherwise open a new one.
  let session = UUID.test(body.session || "") ? body.session! : "";
  if (session) {
    const { data } = await db.from("chat_sessions").select("id, message_count").eq("id", session).eq("channel", "site").maybeSingle();
    if (!data) session = "";
    else if (data.message_count >= MAX_PER_SESSION) return json(req, { session, reply: "השיחה הזו התארכה; נשמח להמשיך בוואטסאפ 050-4770040 או באולם." });
  }
  if (!session) {
    const { data, error } = await db.from("chat_sessions").insert({ channel: "site", ip_hash: ip, page: (body.page || "").toString().slice(0, 200) }).select("id").single();
    if (error) return json(req, { error: "db" }, 500);
    session = data.id;
  }
  const { data: rows } = await db.from("chat_messages").select("role, content").eq("session_id", session).order("created_at").limit(MAX_PER_SESSION * 2);
  const history = (rows || []) as Turn[];

  const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
  let result;
  try { result = await runTurn(client, history, message, "site", { extra: await extraRules("site") }); }
  catch (e) { console.error("anthropic", e); return json(req, { session, reply: "יש לי תקלה רגעית. אפשר לנסות שוב בעוד רגע או לכתוב בוואטסאפ 050-4770040." }, 502); }

  let leadId: number | null = null;
  if (result.lead) {
    // One row per inquiry; the lead log merges repeats by phone (whatsapp/LEADS.md).
    const { data: lid, error } = await db.rpc("upsert_lead", {
      p_channel: "site_form", p_phone: result.lead.phone, p_name: result.lead.name,
      p_source_detail: "site chat bot" + (body.page ? " · " + String(body.page).slice(0, 100) : ""),
      p_first_message: [result.lead.topic, result.lead.preferred_time && "נוח: " + result.lead.preferred_time].filter(Boolean).join(" · ").slice(0, 500),
      p_ref_table: "chat_sessions", p_ref_id: session, p_at: new Date().toISOString(), p_contact_key: null,
    });
    if (error) console.error("upsert_lead", error); else leadId = lid as number;
  }
  await db.from("chat_messages").insert([
    { session_id: session, role: "user", content: message, ip_hash: ip },
    { session_id: session, role: "assistant", content: result.text, tokens_in: result.usage.input + result.usage.cached, tokens_out: result.usage.output },
  ]);
  await db.rpc("chat_session_touch", { p_id: session, p_lead: leadId });
  return json(req, { session, reply: result.text, lead: !!result.lead });
});
