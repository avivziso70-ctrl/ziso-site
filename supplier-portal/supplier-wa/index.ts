// supplier-wa (12.11.2026, Aviv: "להגיד לספקים פשוט לשלוח למספר העסקי שלנו בוואטסאפ את כל המחירונים", "תתקדם לפרוייקט וואטסאפ").
// Price lists that reach the business WhatsApp number go into the same approval queue as portal uploads.
// A cron job calls this every 2 minutes when wa_messages holds a file this function has not looked at yet.
// It never sends anything on WhatsApp and never changes wa-webhook or the customer bot.
//   sender known as a supplier (sp_supplier_phones): every document, and an image whose caption says price list;
//   sender not known: only a spreadsheet, or a file whose name or caption says price list / catalog. It goes to the
//     placeholder supplier (kind 'wa_inbox'); staff assign it once (rpc sp_assign_upload) and the number is remembered.
//   anything else (customers' photos and documents) is not downloaded at all, only its message id is noted as skipped.
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SB_URL, SERVICE_KEY);
const GRAPH = "https://graph.facebook.com/v23.0";
const MAX_BYTES = 20 * 1024 * 1024; // same limit as the portal and the bucket
const BIG_MAX = 100 * 1024 * 1024; // WhatsApp's own limit for a document
const PER_TICK = 4;
const OK_EXT = /\.(xlsx|xlsm|xls|csv|pdf|jpg|jpeg|png|webp)$/i;
const SHEET = /\.(xlsx|xlsm|xls|csv)$/i;
const WORDS = /מחירון|מחירים|קטלוג|price[\s_-]*list|catalog|listino|tarifa/i;
const EXT: Record<string, string> = {
  "application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "text/csv": ".csv",
  "application/vnd.ms-excel": ".xls", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx", "application/vnd.ms-excel.sheet.macroenabled.12": ".xlsm",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const key = (p: unknown) => String(p || "").replace(/\D/g, "").replace(/^972/, "").replace(/^0/, "");
const str = (v: unknown, n: number) => (v == null || String(v).trim() === "" ? null : String(v).trim().slice(0, n));

// deno-lint-ignore no-explicit-any
type Msg = any;

async function take(m: Msg, token: string, inboxId: string) {
  const media = m.raw?.document || m.raw?.image;
  if (!media?.id) return { result: "skip" };
  const caption = String(media.caption || "");
  const mime = String(media.mime_type || "").split(";")[0].trim().toLowerCase();
  let name = String(media.filename || "").trim();
  if (!name) name = `whatsapp_${String(m.ts).slice(0, 10)}${EXT[mime] || ""}`;
  if (!/\.[a-z0-9]{2,5}$/i.test(name) && EXT[mime]) name += EXT[mime];
  const says = WORDS.test(name + " " + caption);
  const { data: ph } = await db.from("sp_supplier_phones").select("supplier_id").eq("phone_key", key(m.phone)).maybeSingle();
  const known = !!ph;
  if (m.type === "image" ? !says : !(known || says || SHEET.test(name))) return { result: "skip" };

  const supplierId = ph?.supplier_id || inboxId;
  const base = {
    supplier_id: supplierId, file_name: name.slice(-120), mime: mime || null, source: "whatsapp", wa_phone: str(m.phone, 20),
    uploader_name: str(`וואטסאפ ${m.phone || ""}${m.name ? " · " + m.name : ""}`, 60), supplier_name_typed: null, supplier_note: str(caption, 4000),
  };
  // a file we cannot take is still shown to staff (and pops in the CRM), so nobody waits for a price list that never arrived
  const fail = async (why: string) => {
    const { data } = await db.from("sp_uploads").insert({ ...base, status: "failed", parse_note: why }).select("id").single();
    return { result: "failed", upload_id: data?.id || null, note: why };
  };
  if (!OK_EXT.test(name)) return known ? await fail("סוג הקובץ לא נתמך. אפשר לקבל PDF, אקסל, CSV או תמונה.") : { result: "skip" };

  const auth = { authorization: `Bearer ${token}` };
  const info = await fetch(`${GRAPH}/${media.id}`, { headers: auth }).then((r) => r.json()).catch(() => null);
  if (!info?.url) return await fail("לא הצלחנו להוריד את הקובץ מוואטסאפ. בקשו מהספק לשלוח אותו שוב.");
  const big = Number(info.file_size) || 0, isPdf = /\.pdf$/i.test(name);
  if (big > MAX_BYTES && !(isPdf && big <= BIG_MAX)) return await fail(`הקובץ גדול מדי (${Math.round(big / 1048576)}MB). אפשר לקבל PDF עד 100MB וקבצים אחרים עד 20MB. בקשו מהספק לפצל אותו.`);
  if (big > MAX_BYTES) {
    // a heavy PDF (catalog with pictures) is not copied into the bucket: supplier-parse reads it straight from WhatsApp, part by part
    const { data: row, error } = await db.from("sp_uploads").insert({ ...base, file_path: `wa:${media.id}`, size_bytes: big }).select("id").single();
    if (error || !row) throw new Error("db " + (error?.message || ""));
    if (known) await db.from("sp_suppliers").update({ last_upload_at: new Date().toISOString() }).eq("id", supplierId);
    await fetch(`${SB_URL}/functions/v1/supplier-upload`, { method: "POST", headers: { "content-type": "application/json", "x-sp-key": SERVICE_KEY }, body: JSON.stringify({ reparse: row.id }) }).catch(() => {});
    return { result: "ok", upload_id: row.id };
  }
  const res = await fetch(info.url, { headers: auth });
  if (!res.ok) return await fail("לא הצלחנו להוריד את הקובץ מוואטסאפ. בקשו מהספק לשלוח אותו שוב.");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES) return await fail("הקובץ גדול מדי (עד 20MB). בקשו מהספק לפצל אותו או לשלוח אקסל.");

  const path = `${supplierId}/${Date.now()}_${name.replace(/[^\w.\-א-ת]+/g, "_").slice(-80)}`;
  const { error: upErr } = await db.storage.from("supplier-files").upload(path, bytes, { contentType: mime || "application/octet-stream" });
  if (upErr) return await fail("שמירת הקובץ נכשלה. בקשו מהספק לשלוח אותו שוב.");
  const { data: row, error } = await db.from("sp_uploads").insert({ ...base, file_path: path, size_bytes: bytes.length }).select("id").single();
  if (error || !row) throw new Error("db " + (error?.message || ""));
  if (known) await db.from("sp_suppliers").update({ last_upload_at: new Date().toISOString() }).eq("id", supplierId);
  // the reading itself is done by the same code as a portal upload
  await fetch(`${SB_URL}/functions/v1/supplier-upload`, { method: "POST", headers: { "content-type": "application/json", "x-sp-key": SERVICE_KEY }, body: JSON.stringify({ reparse: row.id }) }).catch(() => {});
  return { result: "ok", upload_id: row.id };
}

async function tick() {
  const since = new Date(Date.now() - 48 * 3600_000).toISOString();
  const { data: msgs } = await db.from("wa_messages").select("id, ts, phone, name, type, raw").eq("dir", "in").eq("source", "live").in("type", ["document", "image"]).gte("ts", since).order("ts").limit(300);
  if (!msgs?.length) return;
  const seen = new Set<string>();
  for (let i = 0; i < msgs.length; i += 100) {
    const { data } = await db.from("sp_wa_log").select("msg_id").in("msg_id", msgs.slice(i, i + 100).map((m) => m.id));
    (data || []).forEach((r) => seen.add(r.msg_id));
  }
  const fresh = msgs.filter((m) => !seen.has(m.id));
  if (!fresh.length) return;
  const { data: cfg } = await db.from("wa_config").select("token").limit(1).maybeSingle();
  const { data: inbox } = await db.from("sp_suppliers").select("id").eq("kind", "wa_inbox").limit(1).maybeSingle();
  if (!cfg?.token || !inbox?.id) return;
  let taken = 0;
  for (const m of fresh) {
    if (taken >= PER_TICK) break;
    // claim the message first: a second run at the same moment gets a conflict and leaves it alone
    const { error: claim } = await db.from("sp_wa_log").insert({ msg_id: m.id, result: "working" });
    if (claim) continue;
    let out: { result: string; upload_id?: string | null; note?: string };
    try { out = await take(m, cfg.token, inbox.id); } catch (e) { out = { result: "failed", note: String((e as Error).message || e).slice(0, 200) }; }
    await db.from("sp_wa_log").update({ result: out.result, upload_id: out.upload_id || null, note: out.note || null }).eq("msg_id", m.id);
    if (out.result !== "skip") taken++;
  }
}

Deno.serve((req) => {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  // @ts-ignore EdgeRuntime is provided by Supabase
  EdgeRuntime.waitUntil(tick());
  return json({ ok: true }, 202);
});
