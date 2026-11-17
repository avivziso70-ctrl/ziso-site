// crm-my-invite (17.11.2026): sends the WhatsApp invite to a new customer's personal page (template ziso_my_page,
// UTILITY, wording approved by Aviv 17.11). Rows come from crm_my_invites (made by crm_my_auto_open).
// Gates, all checked here on every run:
//   1. the template is APPROVED at Meta, otherwise nothing is sent;
//   2. crm_settings.my_invites_on is true, otherwise only rows with note 'test' are sent (the test number);
//   3. sending hours Israel: Sun-Thu 09-20, Fri 09-14, never Saturday;
//   4. the page is still open (share_token), the invite is under 14 days old, the phone is not a supplier or family/staff;
//   5. at most 10 per run. Never returns the token.
import { createClient } from "npm:@supabase/supabase-js@2";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const G = "https://graph.facebook.com/v23.0";
const TPL = "ziso_my_page", MY = "https://www.zisoceramics.com/my/#";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

function hoursOk() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", weekday: "short", hour: "numeric", hourCycle: "h23" })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  const h = Number(p.hour), d = p.weekday;
  if (d === "Sat") return false;
  if (d === "Fri") return h >= 9 && h < 14;
  return h >= 9 && h < 20;
}

Deno.serve(async () => {
  const { data: cfg } = await db.from("wa_config").select("token, waba_id, phone_number_id").eq("id", 1).maybeSingle();
  if (!cfg?.token) return json({ ok: false, error: "wa_config empty" }, 500);
  const h = { Authorization: `Bearer ${cfg.token}` };
  const t = await (await fetch(`${G}/${cfg.waba_id}/message_templates?name=${TPL}&fields=name,status`, { headers: h })).json().catch(() => ({}));
  const tstatus = t?.data?.[0]?.status || "missing";
  if (tstatus !== "APPROVED") return json({ ok: true, sent: 0, template: tstatus });
  if (!hoursOk()) return json({ ok: true, sent: 0, reason: "hours" });

  const { data: st } = await db.from("crm_settings").select("my_invites_on").eq("id", 1).maybeSingle();
  let q = db.from("crm_my_invites").select("id, deal_id, tail9, note, created_at").in("status", ["waiting_template", "queued"]).order("id").limit(10);
  if (!st?.my_invites_on) q = q.eq("note", "test");
  const { data: rows } = await q;
  const { data: fam } = await db.from("wa_family").select("phone");
  const famTails = new Set((fam || []).map((f: any) => String(f.phone || "").replace(/\D/g, "").slice(-9)));
  let sent = 0; const out: unknown[] = [];
  for (const r of rows || []) {
    const isTest = r.note === "test";
    const set = (patch: Record<string, unknown>) => db.from("crm_my_invites").update(patch).eq("id", r.id);
    const { data: d } = await db.from("crm_deals").select("id, customer_name, customer_tail9, share_token").eq("id", r.deal_id).maybeSingle();
    if (!d?.share_token) { await set({ status: "cancelled", note: "הדף סגור" }); continue; }
    if (!isTest && Date.now() - new Date(r.created_at).getTime() > 14 * 864e5) { await set({ status: "skipped", note: "ישן מ-14 יום" }); continue; }
    if (!/^5\d{8}$/.test(r.tail9) || r.tail9 !== d.customer_tail9) { await set({ status: "skipped", note: "טלפון לא תקין" }); continue; }
    if (!isTest && famTails.has(r.tail9)) { await set({ status: "skipped", note: "מספר של המשפחה/צוות" }); continue; }
    const { count: sup } = await db.from("sp_supplier_phones").select("*", { count: "exact", head: true }).in("phone_key", [r.tail9, r.tail9.slice(-8), r.tail9.slice(-7), "0" + r.tail9, "972" + r.tail9]);
    if (!isTest && (sup || 0) > 0) { await set({ status: "skipped", note: "מספר של ספק" }); continue; }
    const name = String(d.customer_name || "").replace(/\s+/g, " ").trim().slice(0, 40) || "לקוח יקר";
    const link = MY + d.share_token;
    const payload = { messaging_product: "whatsapp", to: "972" + r.tail9, type: "template",
      template: { name: TPL, language: { code: "he" }, components: [{ type: "body", parameters: [{ type: "text", text: name }, { type: "text", text: link }] }] } };
    const sr = await fetch(`${G}/${cfg.phone_number_id}/messages`, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify(payload) });
    const sj = await sr.json().catch(() => ({}));
    const wamid = sj?.messages?.[0]?.id;
    if (!sr.ok || !wamid) { await set({ status: "failed", note: "שליחה נכשלה: " + String(sj?.error?.message || sr.status).slice(0, 200) }); out.push({ id: r.id, ok: false }); continue; }
    await set({ status: "sent", sent_at: new Date().toISOString(), wa_msg_id: wamid });
    await db.from("wa_messages").upsert({ id: wamid, ts: new Date().toISOString(), phone: "0" + r.tail9, dir: "out", type: "template",
      text: `הזמנה לדף האישי (${TPL})`, name: null, source: "crm", biz_phone: "972504770040",
      raw: { template: TPL, crm: { by: "crm-my-invite", invite_id: r.id, deal_id: d.id, test: isTest } } }, { onConflict: "id", ignoreDuplicates: true });
    sent++; out.push({ id: r.id, ok: true });
  }
  return json({ ok: true, sent, template: tstatus, live: !!st?.my_invites_on, rows: out });
});
