// crm-po: supplier orders by email from the CRM (table crm_po, see crm-ai/crm_po.sql). First supplier: Dior -> Irena.
// Staff (Supabase JWT of an active crm_staff user):
//   { action: "create", supplier_id, lines: [{ price_id, qty }], note? } -> prices re-read from sp_prices, total on the server, status queued
//   { action: "cancel", id }                                            -> only while still queued (not sent yet)
//   { action: "mark", id, status: "confirmed" | "attention" | "sent" }  -> manual override after reading the mail
// Apps Script "Ziso Priority Bridge" (SupplierOrders.gs, header x-import-key = the bridge's CRM_IMPORT_KEY, same as crm-import):
//   { action: "outbox" }                         -> claims queued orders (status sending) and returns ready-to-send emails
//   { action: "sent", id, thread_id, msg_id }    -> status sent (yellow)
//   { action: "send_failed", id, error }         -> status failed
//   { action: "watch" }                          -> sent / attention orders with their Gmail thread + message ids already seen
//   { action: "reply", id, msg_id, from, date, text } -> a new message on the thread. Only the supplier's domain counts;
//       Claude reads it: confirmed -> green, question / partial / refusal / unclear -> attention (never green), auto-reply -> no change.
//       Returns { forward } = true when it is the supplier's message (the script forwards it to Eilat + Shir if they were not on it).
// An order stuck in "sending" for 20 minutes (send result never reported) becomes attention: check Gmail before resending.
// WhatsApp suppliers (Sanitec, Aviv 15.11: "סניטק עובדים דרך דודי בוואטסאפ"): sp_suppliers.order_wa_phone set -> "create" sends
//   right away from the business number (staff pressed "כן, לשלוח" = the yes): free text inside Meta's 24h window, otherwise the
//   approved UTILITY template ziso_supplier_order. The row goes into wa_messages (source 'crm', bot stays quiet).
//   His answers arrive from the wa_messages trigger crm_po_wa_in -> { action: "wa_reply" } with x-hook-token (crm_push_keys).
//   Supplier with both order_wa_phone and order_email (Sanitec, Aviv 15.11): channel "both" = the WhatsApp goes at once and the
//   email (cc Eilat + Shir) goes through the outbox, tracked in email_state; answers on either channel update the same order.
//   sp_suppliers.order_paused (e.g. while a price list is being fixed) blocks "create".
//   Owner only: { action: "wa_template", submit? } shows the template's status at Meta, and submits it once on his click.
// Delivery (Aviv 15.11): every order says where the goods go: deliver_to 'business' (default) or 'customer' with
//   deliver { name, phone, address, note, tail9 } taken from the customer card or typed by staff. Only what the delivery needs
//   goes to the supplier (name, phone, address).
// Customer (Aviv 15.11): every order carries the customer it is for (customer_name, from the customer card or typed), or is
//   marked as stock. The name goes to the supplier as the order's reference.
// Cancel (Aviv 15.11): { action: "cancel", id } on an order that already went out marks it cancelled and tells the supplier on the
//   channels the order used: WhatsApp at once (free text in the 24h window, otherwise template ziso_supplier_cancel), email through
//   the outbox (same cc), returned there with a negative id (-order id) so the Apps Script needs no change.
// Loop closing (Aviv 15.11: "שגורם מטעמו יאשר"): every order waits for a supplier rep to confirm it, every cancellation waits
//   for a rep to confirm the cancel (cancel_ack waiting -> confirmed / attention). Answers count on both channels: the order
//   thread, the cancellation mail's own thread (watched with a negative id, so the Apps Script needs no change) and WhatsApp.
//   No answer in time -> crm_po_overdue() (pg_cron, working hours) opens a call-the-supplier task + push; an answer closes it.
//   Staff can also mark a phone confirmation: { action: "mark", id, status: "cancel_confirmed" }.
// A question to a supplier's order contact (Aviv 15.11: "תראיין אותה, תשאל אותה האם לכלול עוד מישהו? האם יש מיילים"):
//   { action: "wa_ask", supplier_id, text, by } with x-hook-token, called only by the database function crm_po_ask.
//   Free text to sp_suppliers.order_wa_phone, so only inside Meta's 24h window; kept in wa_messages (source 'crm') and crm_audit.
//   Staff: { action: "price_ask", deal_id, lid, supplier_id, model, size, color, note } asks a supplier that prices on request
//   (price_by_ask) for a price, with the customer's name: free text inside the 24h window, otherwise template
//   ziso_supplier_price. Saved in crm_price_asks; the answer is attached there by the wa_messages trigger crm_price_ask_in.
// Online store (Aviv 18.11.2026: "כשלקוח מזמין - שתשלח הזמנה לספק אוטומטית במידה ומחוברים לו אנשי קשר כמו שצריך - ותאזין
//   לתשובה"): { action: "shop_order", order_id } with x-hook-token, called by the database function crm_po_shop when a store
//   order turns paid, and again from the outbox for an order the call missed. The order is read here (never from the caller):
//   paid, not a test, not handled yet. One crm_po per supplier (origin 'shop', shop_order_id), on the supplier's registered
//   order channel, delivered to the business, with "הזמנת אתר N" as the reference (the customer's name and phone stay with us).
//   Not sent, and a staff task instead: supplier with no order contact or paused, an item we hold in stock, a failed send.
//   Outside working hours the order waits for the first outbox run of the next working day. Answers, no-answer alerts and
//   cancellations are the same as for any order.
// The WhatsApp token is read here through the service role only, never returned or logged; wa_config is never written.
// Priority is never written.
import { createClient } from "npm:@supabase/supabase-js@2";
import { SHOP_BASE, shopMailResult, shopOutbox } from "../../shop/function/mail.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { autoRefreshToken: false, persistSession: false } });
const IMPORT_SHA256 = "f34768d670cc85ef42eb41294bd0d101707b94e00ad2659ecf28439dbc6852d0";
const TEAM_CC = ["eilatziso50@gmail.com", "shirziso1605@gmail.com"]; // Aviv 15.11: every order mail and every answer goes to Eilat and Shir too
// plus the supplier's own cc list (sp_suppliers.order_cc), e.g. Dior's sales agent Ilan Beni (Aviv 15.11)
const MODEL = Deno.env.get("PO_MODEL") || "claude-haiku-5-5";
const OWNER = "avivziso70@gmail.com";
const GRAPH = "https://graph.facebook.com/v23.0";
const WA_TEMPLATE = "ziso_supplier_order";
const WA_TEMPLATE_BODY = 'שלום {{1}}, זו הזמנת רכש {{2}} מזיסו קרמיקה:\n{{3}}\nסה"כ {{4}} לפני מע"מ.\nנא לאשר את ההזמנה בתשובה להודעה הזו, ולציין אם חסר פריט או שהמחיר השתנה.';
const WA_CANCEL = "ziso_supplier_cancel";
const WA_CANCEL_BODY = 'שלום {{1}}, אנחנו מבטלים את הזמנת רכש {{2}} מזיסו קרמיקה (סה"כ {{3}} לפני מע"מ). נא לא לספק אותה, ולאשר בתשובה להודעה הזו שהביטול התקבל.';
// a price request to a supplier that has no price list (sp_suppliers.price_by_ask, first: Onda). Aviv 17.11.2026.
const WA_PRICE = "ziso_supplier_price";
const WA_PRICE_BODY = 'שלום {{1}}, בקשת מחיר מזיסו קרמיקה: {{2}}. עבור לקוח: {{3}}. נשמח למחיר ולזמן אספקה בתשובה להודעה הזו. תודה, {{4}}, זיסו קרמיקה.';
const WINDOW_MS = 23.5 * 3600 * 1000;
const BUSINESS_ADDR = "זיסו קרמיקה, עוצמה 5, טירת כרמל";
const localPhone = (s: unknown) => { let d = String(s ?? "").replace(/\D/g, ""); if (d.startsWith("972")) d = "0" + d.slice(3); return d.length === 10 ? d.slice(0, 3) + "-" + d.slice(3) : d; };
export const customerLine = (po: Record<string, any>) => (po.customer_name ? (po.shop_order_id ? "סימוכין: " : "עבור לקוח: ") + po.customer_name : "");
// one line for the supplier: where the goods go
export function deliverLine(po: Record<string, any>) {
  const d = po.deliver || {};
  if (po.deliver_to !== "customer") return "אספקה: לבית העסק, " + BUSINESS_ADDR;
  return `אספקה ישירות ללקוח: ${d.name}, ${d.address}, טלפון ${localPhone(d.phone)}${d.note ? " (" + d.note + ")" : ""}`;
}
const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "");
const tail9 = (s: unknown) => { const d = digits(s); return d.length >= 9 ? d.slice(-9) : ""; };
const ORIGINS = ["https://www.zisoceramics.com", "https://zisoceramics.com", "http://localhost:8000"];
function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return { "access-control-allow-origin": ORIGINS.includes(o) ? o : ORIGINS[0], "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "POST, OPTIONS", vary: "origin", "content-type": "application/json" };
}
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors(req) });
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s || "")));
const r2 = (n: number) => Math.round(n * 100) / 100;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const ils = (n: number) => "₪" + Number(n).toLocaleString("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const domainOf = (e: string) => (String(e).toLowerCase().match(/@([a-z0-9.-]+)/) || [])[1] || "";

type Line = { price_id: number; sku: string | null; desc: string | null; size: string | null; unit: string | null; qty: number; price: number; total: number };
type Po = Record<string, any>;

export function renderEmail(po: Po) {
  const lines = po.lines as Line[];
  const subject = `זיסו קרמיקה - הזמנת רכש ${po.po_no}`;
  const hello = po.contact ? `שלום ${po.contact},` : "שלום רב,";
  const td = 'style="border:1px solid #ccc;padding:6px 8px;text-align:right"';
  const rows = lines.map((l, i) => `<tr><td ${td}>${i + 1}</td><td ${td} dir="ltr">${esc(l.sku)}</td><td ${td}>${esc(l.desc)}${l.size ? " " + esc(l.size) : ""}</td><td ${td}>${l.qty}</td><td ${td}>${esc(l.unit || "")}</td><td ${td}>${ils(l.price)}</td><td ${td}>${ils(l.total)}</td></tr>`).join("");
  const note = po.note ? `<p><b>הערה:</b> ${esc(po.note)}</p>` : "";
  const html = `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px;color:#222">
<p>${esc(hello)}</p>
<p>מצורפת הזמנת רכש מס' <b>${esc(po.po_no)}</b> מזיסו קרמיקה:</p>
<table style="border-collapse:collapse;margin:8px 0"><thead><tr><th ${td}>#</th><th ${td}>מק"ט</th><th ${td}>תיאור</th><th ${td}>כמות</th><th ${td}>יחידה</th><th ${td}>מחיר ליח'</th><th ${td}>סה"כ</th></tr></thead>
<tbody>${rows}</tbody>
<tfoot><tr><td ${td} colspan="6"><b>סה"כ לפני מע"מ</b></td><td ${td}><b>${ils(po.total_cost)}</b></td></tr></tfoot></table>
<p style="color:#555">המחירים לפי המחירון שלכם, לפני מע"מ.</p>
${po.customer_name ? `<p>${esc(customerLine(po))}</p>` : ""}<p><b>${esc(deliverLine(po))}</b></p>
${note}<p><b>נא אשרו את ההזמנה וזמינות הפריטים במייל חוזר.</b> אם פריט חסר או שהמחיר השתנה, נא לציין בתשובה.</p>
<p>תודה,<br>זיסו קרמיקה בע"מ<br>עוצמה 5, טירת כרמל · 050-4770040</p></div>`;
  const text = [hello, "", `מצורפת הזמנת רכש מס' ${po.po_no} מזיסו קרמיקה:`, "",
    ...lines.map((l, i) => `${i + 1}. ${l.sku ? "מק\"ט " + l.sku + " | " : ""}${l.desc}${l.size ? " " + l.size : ""} | כמות ${l.qty}${l.unit ? " " + l.unit : ""} | ${ils(l.price)} ליח' | ${ils(l.total)}`),
    "", `סה"כ לפני מע"מ: ${ils(po.total_cost)}`, "המחירים לפי המחירון שלכם, לפני מע\"מ.",
    "", ...(po.customer_name ? [customerLine(po)] : []), deliverLine(po),
    ...(po.note ? ["", "הערה: " + po.note] : []),
    "", "נא אשרו את ההזמנה וזמינות הפריטים במייל חוזר. אם פריט חסר או שהמחיר השתנה, נא לציין בתשובה.", "", "תודה,", "זיסו קרמיקה בע\"מ", "עוצמה 5, טירת כרמל · 050-4770040"].join("\n");
  return { subject, html, text };
}

export function renderCancelEmail(po: Po) {
  const lines = po.lines as Line[];
  const hello = po.contact ? `שלום ${po.contact},` : "שלום רב,";
  const day = new Date(po.sent_at || po.created_at).toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem" });
  const subject = `זיסו קרמיקה - ביטול הזמנת רכש ${po.po_no}`;
  const items = lines.map((l, i) => `${i + 1}. ${l.sku ? "מק\"ט " + l.sku + " | " : ""}${l.desc}${l.size ? " " + l.size : ""} | כמות ${l.qty}${l.unit ? " " + l.unit : ""}`);
  const text = [hello, "", `אנחנו מבטלים את הזמנת רכש מס' ${po.po_no} מיום ${day} (סה"כ ${ils(po.total_cost)} לפני מע"מ):`, "", ...items, "",
    "נא לא לספק את ההזמנה, ולאשר במייל חוזר שהביטול התקבל.", "", "תודה,", "זיסו קרמיקה בע\"מ", "עוצמה 5, טירת כרמל · 050-4770040"].join("\n");
  const html = `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px;color:#222">
<p>${esc(hello)}</p>
<p>אנחנו <b>מבטלים</b> את הזמנת רכש מס' <b>${esc(po.po_no)}</b> מיום ${esc(day)} (סה"כ ${ils(po.total_cost)} לפני מע"מ):</p>
<ol>${lines.map((l) => `<li>${l.sku ? '<span dir="ltr">' + esc(l.sku) + "</span> " : ""}${esc(l.desc)}${l.size ? " " + esc(l.size) : ""} · כמות ${l.qty}${l.unit ? " " + esc(l.unit) : ""}</li>`).join("")}</ol>
<p><b>נא לא לספק את ההזמנה, ולאשר במייל חוזר שהביטול התקבל.</b></p>
<p>תודה,<br>זיסו קרמיקה בע"מ<br>עוצמה 5, טירת כרמל · 050-4770040</p></div>`;
  return { subject, html, text };
}

// Keep only the new part of a reply: cut the quoted original (Gmail / Outlook headers, "> " lines).
export function newPart(t: string) {
  const lines = String(t || "").replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) break;
    if (/^\s*(On .+wrote:|ב[-־]?.+כתב[ה]?:|.*<[^>]+@[^>]+>\s*(כתב|wrote)|-{2,}\s*(Original Message|הודעה מקורית)|From:\s|מאת:\s)/i.test(l)) break;
    out.push(l);
  }
  return out.join("\n").trim().slice(0, 3000);
}

export async function classify(po: Po, text: string, fetcher: typeof fetch = fetch, kind: "order" | "cancel" = "order"): Promise<{ verdict: string; summary: string }> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return { verdict: "unclear", summary: "לא הצלחתי לקרוא את התשובה אוטומטית, לבדוק במייל" };
  const items = (po.lines as Line[]).map((l) => `${l.sku ?? ""} ${l.desc ?? ""} x${l.qty}`).join("; ");
  const system = `You read a supplier's email reply to a purchase order from Ziso Ceramics (Israel). Reply ONLY with JSON: {"verdict": "...", "summary": "..."}.
verdict is exactly one of:
- "confirmed": the supplier clearly confirms the whole order as sent (e.g. "מאושר", "התקבל ויסופק", "אושר, תודה"), with no missing items, no changed prices, no open question.
- "partial": confirms only part, some item missing / out of stock / back-ordered, or a different quantity or price.
- "question": asks something or needs something before confirming.
- "rejected": refuses or cannot supply.
- "auto": an automatic reply (out of office, auto-acknowledgement by a system) that says nothing about the order.
- "unclear": anything else.
When in doubt, never say "confirmed". "התקבל" alone (received) without confirming supply counts as "confirmed" only if nothing else is raised.
summary: one short Hebrew sentence (max 20 words) of what the supplier said, naming missing items or dates if any.`;
  const systemCancel = `Ziso Ceramics (Israel) CANCELLED a purchase order and asked the supplier to confirm the cancellation. You read the supplier's reply. Reply ONLY with JSON: {"verdict": "...", "summary": "..."}.
verdict is exactly one of:
- "confirmed": the supplier clearly confirms the order is cancelled / will not be supplied (e.g. "בוטל", "ביטלתי", "מבוטל", "התקבל, לא נספק", "אוקיי בוטל").
- "too_late": the goods already left / were supplied / were charged, or the supplier cannot cancel.
- "question": asks something before cancelling.
- "auto": an automatic reply that says nothing about the order.
- "unclear": anything else, including a bare "ok"/"תודה" that does not say the order is cancelled.
When in doubt, never say "confirmed".
summary: one short Hebrew sentence (max 20 words) of what the supplier said.`;
  const VERDICTS = kind === "cancel" ? ["confirmed", "too_late", "question", "auto", "unclear"] : ["confirmed", "partial", "question", "rejected", "auto", "unclear"];
  try {
    const r = await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 300, system: kind === "cancel" ? systemCancel : system, messages: [{ role: "user", content: `${kind === "cancel" ? "Cancelled order" : "Order"} ${po.po_no}: ${items}\n\nSupplier reply:\n${text}` }] }),
    });
    if (!r.ok) throw new Error("api " + r.status);
    const j = await r.json();
    const t = (j.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    const m = t.match(/\{[\s\S]*\}/);
    const o = m ? JSON.parse(m[0]) : {};
    const verdict = VERDICTS.includes(o.verdict) ? o.verdict : "unclear";
    return { verdict, summary: String(o.summary || "").slice(0, 200) || "לבדוק את התשובה במייל" };
  } catch (_e) {
    return { verdict: "unclear", summary: "לא הצלחתי לקרוא את התשובה אוטומטית, לבדוק במייל" };
  }
}

const lineText = (l: Line) => `${l.sku ?? ""} ${l.desc ?? ""}${l.size ? " " + l.size : ""} × ${l.qty}${l.unit ? " " + l.unit : ""}`.replace(/\s+/g, " ").trim();
// The supplier answered a cancellation: confirmed -> done, anything else -> attention (task + push from the DB trigger).
export function cancelPatch(c: { verdict: string; summary: string }, at: string, now: string): Record<string, unknown> {
  if (c.verdict === "auto") return {};
  const ok = c.verdict === "confirmed";
  return { cancel_ack: ok ? "confirmed" : "attention", cancel_ack_at: at, cancel_summary: (c.verdict === "too_late" ? "יתכן שכבר מאוחר: " : "") + c.summary, ...(ok ? { cancel_confirmed_at: now } : {}) };
}
// An answer arrived: the "no answer yet, call him" task is not needed any more.
async function closeNudge(po: Po, which: "order" | "cancel") {
  const tid = which === "order" ? po.nudge_task_id : po.cancel_nudge_task_id;
  if (tid) await admin.from("crm_tasks").update({ done_at: new Date().toISOString(), done_by: "הספק ענה" }).eq("id", tid).is("done_at", null);
}
const awaitingCancel = (po: Po) => po.status === "cancelled" && (po.cancel_ack === "waiting" || po.cancel_ack === "attention");

export function waFullText(po: Po) {
  const lines = po.lines as Line[];
  return [`שלום ${po.contact || ""}, זו הזמנת רכש ${po.po_no} מזיסו קרמיקה:`.replace(/\s+,/, ","), "",
    ...lines.map((l) => `• ${lineText(l)} · ${ils(l.price)} ליח' = ${ils(l.total)}`), "",
    `סה"כ ${ils(po.total_cost)} לפני מע"מ.`, ...(po.customer_name ? [customerLine(po)] : []), deliverLine(po), ...(po.note ? ["הערה: " + po.note] : []), "",
    "נא לאשר את ההזמנה בתשובה להודעה הזו, ולציין אם חסר פריט או שהמחיר השתנה.", "זיסו קרמיקה"].join("\n");
}
// Template parameters cannot hold new lines, tabs or more than 4 spaces in a row; keep {{3}} under 900 characters.
export function waTemplateParams(po: Po) {
  const flat = (t: string) => t.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  const lines = po.lines as Line[];
  const parts = lines.map((l) => flat(`${lineText(l)} (${ils(l.total)})`));
  let items = "", n = 0;
  for (const p of parts) { const next = items ? items + " · " + p : p; if (next.length > 620) break; items = next; n++; }
  const truncated = n < parts.length;
  if (truncated) items += ` · ועוד ${parts.length - n} שורות, הפירוט המלא יישלח מיד אחרי תשובתך`;
  if (po.customer_name && po.deliver_to !== "customer") items = flat(items + " · " + customerLine(po));
  items = flat(items + " · " + deliverLine(po).slice(0, 200));
  if (po.note) items = flat(items + " · הערה: " + String(po.note).slice(0, 60));
  return { params: [flat(po.contact || "שלום"), String(po.po_no), items.slice(0, 950), ils(po.total_cost)], truncated };
}
async function waCfg() {
  const { data } = await admin.from("wa_config").select("token, phone_number_id, waba_id").eq("id", 1).maybeSingle();
  return data;
}
async function waPost(cfg: any, payload: unknown) {
  const r = await fetch(`${GRAPH}/${cfg.phone_number_id}/messages`, { method: "POST", headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" }, body: JSON.stringify(payload) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && !!j?.messages?.[0]?.id, id: j?.messages?.[0]?.id as string | undefined, error: j?.error ? `${j.error.message || ""}${j.error.code ? " (" + j.error.code + ")" : ""}` : (r.ok ? "" : "HTTP " + r.status) };
}
async function waRecord(po: Po, wamid: string, type: string, text: string, by: string, extra: Record<string, unknown> = {}) {
  let d = digits(po.to_phone); if (d.startsWith("0")) d = "972" + d.slice(1);
  const local = d.startsWith("972") ? "0" + d.slice(3) : d;
  await admin.from("wa_messages").upsert({ id: wamid, ts: new Date().toISOString(), phone: local, dir: "out", type, text, name: po.supplier_name, source: "crm", biz_phone: "972504770040",
    raw: { crm: { by, po: po.po_no }, ...extra } }, { onConflict: "id", ignoreDuplicates: true });
}
async function windowOpen(t9: string) {
  const { data } = await admin.from("wa_messages").select("ts").like("phone", "%" + t9).eq("dir", "in").eq("source", "live").neq("type", "errors").order("ts", { ascending: false }).limit(1).maybeSingle();
  return !!data && Date.now() - new Date(data.ts).getTime() < WINDOW_MS;
}
// Send one WhatsApp order. Called once per order, right after "create" (status sending).
export async function sendWa(po: Po, by: string) {
  const now = new Date().toISOString();
  const cfg = await waCfg();
  const fail = async (error: string) => { await admin.from("crm_po").update({ status: "failed", error, updated_at: now }).eq("id", po.id); return { ...po, status: "failed", error }; };
  if (!cfg?.token || !cfg?.phone_number_id) return fail("וואטסאפ לא מחובר");
  const t9 = tail9(po.to_phone);
  if (!t9) return fail("אין מספר וואטסאפ לספק");
  let to = digits(po.to_phone); if (to.startsWith("0")) to = "972" + to.slice(1);
  const full = waFullText(po);
  let res, type = "text", truncated = false, extra: Record<string, unknown> = {};
  if (await windowOpen(t9)) {
    res = await waPost(cfg, { messaging_product: "whatsapp", to, type: "text", text: { body: full.slice(0, 4000), preview_url: false } });
  } else {
    const t = waTemplateParams(po); truncated = t.truncated; type = "template"; extra = { template: WA_TEMPLATE };
    res = await waPost(cfg, { messaging_product: "whatsapp", to, type: "template", template: { name: WA_TEMPLATE, language: { code: "he" }, components: [{ type: "body", parameters: t.params.map((x) => ({ type: "text", text: x })) }] } });
    if (!res.ok && /template|132\d{3}/i.test(res.error)) res.error = "תבנית ההודעה לספקים עוד לא מאושרת במטא, אז אי אפשר לפתוח שיחה עם הספק. " + res.error;
  }
  if (!res.ok || !res.id) return fail("השליחה בוואטסאפ נכשלה: " + (res.error || "שגיאה").slice(0, 250));
  await waRecord(po, res.id, type, full, by, extra);
  const patch = { status: "sent", sent_at: now, wa_msg_id: res.id, wa_truncated: truncated, error: null, updated_at: now };
  await admin.from("crm_po").update(patch).eq("id", po.id);
  return { ...po, ...patch };
}

// Tell the supplier on WhatsApp that an order is cancelled. Returns "sent" or the Hebrew reason it did not go.
export async function sendWaCancel(po: Po, by: string): Promise<{ ok: boolean; error?: string }> {
  const cfg = await waCfg();
  const t9 = tail9(po.to_phone);
  if (!cfg?.token || !cfg?.phone_number_id || !t9) return { ok: false, error: "וואטסאפ לא מחובר" };
  let to = digits(po.to_phone); if (to.startsWith("0")) to = "972" + to.slice(1);
  const text = `שלום ${po.contact || ""}, אנחנו מבטלים את הזמנת רכש ${po.po_no} מזיסו קרמיקה (סה"כ ${ils(po.total_cost)} לפני מע"מ). נא לא לספק אותה, ולאשר בתשובה להודעה הזו שהביטול התקבל.`.replace(/\s+,/, ",");
  let res, type = "text", extra: Record<string, unknown> = {};
  if (await windowOpen(t9)) res = await waPost(cfg, { messaging_product: "whatsapp", to, type: "text", text: { body: text, preview_url: false } });
  else {
    type = "template"; extra = { template: WA_CANCEL };
    res = await waPost(cfg, { messaging_product: "whatsapp", to, type: "template", template: { name: WA_CANCEL, language: { code: "he" },
      components: [{ type: "body", parameters: [String(po.contact || "שלום"), String(po.po_no), ils(po.total_cost)].map((x) => ({ type: "text", text: x })) }] } });
    if (!res.ok && /template|132\d{3}/i.test(res.error)) res.error = "תבנית הודעת הביטול עוד לא מאושרת במטא. " + res.error;
  }
  if (!res.ok || !res.id) return { ok: false, error: (res.error || "שגיאה").slice(0, 250) };
  await waRecord(po, res.id, type, text, by, extra);
  return { ok: true };
}

// One order to one supplier: prices re-read from the supplier's active list, total computed here, WhatsApp at once and the
// email through the outbox. Used by staff "create" and by the online store's paid orders (shopOrder).
type Place = { customerName: string | null; customerT9: string | null; deliver: Record<string, unknown> | null; note: string | null; by: string; byName: string | null; dealId?: number; shopOrderId?: number };
async function placePo(sup: any, qtyById: Map<number, number>, o: Place, now: string): Promise<{ ok: boolean; po?: Po; error?: string; code?: number; warn?: string }> {
  const wa = !!(sup.order_wa_phone && tail9(sup.order_wa_phone));
  const mail = !!sup.order_email;
  const channel = wa && mail ? "both" : wa ? "whatsapp" : "email";
  const { data: prices } = await admin.from("sp_prices").select("id, supplier_id, supplier_code, description, size, unit, price, currency, vat_included, status").in("id", [...qtyById.keys()]);
  const byId = new Map((prices || []).map((p: any) => [Number(p.id), p]));
  const lines: Line[] = [];
  for (const [id, qty] of qtyById) {
    const p: any = byId.get(id);
    if (!p || p.supplier_id !== sup.id || p.status !== "active") return { ok: false, error: "פריט לא נמצא במחירון הפעיל של הספק", code: 400 };
    if (p.price == null || (p.currency && p.currency !== "ILS")) return { ok: false, error: `לפריט ${p.supplier_code} אין מחיר בשקלים`, code: 400 };
    const price = p.vat_included ? r2(Number(p.price) / 1.18) : Number(p.price);
    lines.push({ price_id: id, sku: p.supplier_code, desc: p.description, size: p.size, unit: p.unit, qty, price, total: r2(price * qty) });
  }
  const total = r2(lines.reduce((s, l) => s + l.total, 0));
  const { data: po, error } = await admin.from("crm_po").insert({
    supplier_id: sup.id, supplier_name: sup.name, channel, to_phone: wa ? sup.order_wa_phone : null,
    to_email: mail ? sup.order_email : null, email_state: channel === "both" ? "queued" : null, cc: !mail ? [] : [...new Set([...TEAM_CC, ...((sup.order_cc || []) as string[]).map((e) => String(e).trim().toLowerCase()).filter(Boolean)])], contact: sup.order_contact, lines, total_cost: total, note: o.note, deliver_to: o.deliver ? "customer" : "business", deliver: o.deliver, customer_name: o.customerName, customer_tail9: o.customerT9,
    ...(o.dealId ? { deal_id: o.dealId } : {}), ...(o.shopOrderId ? { origin: "shop", shop_order_id: o.shopOrderId } : {}),
    status: wa ? "sending" : "queued", claimed_at: wa ? now : null, by: o.by, by_name: o.byName, updated_at: now,
  }).select("*").single();
  if (error) return { ok: false, error: error.message, code: 500 };
  await admin.from("crm_audit").insert({ who: o.by, action: "po_create", detail: { id: po.id, po: po.po_no, supplier: sup.name, lines: lines.length, total, channel: po.channel, ...(o.shopOrderId ? { shop_order: o.shopOrderId } : {}) } });
  if (!wa) return { ok: true, po };
  const out = await sendWa(po, o.by);
  // "both": the email still goes out through the outbox even if the WhatsApp failed
  if (out.status !== "sent") return channel === "both" ? { ok: true, po: out, warn: out.error } : { ok: false, po: out, error: out.error, code: 502 };
  return { ok: true, po: out };
}

const SHOP_BY = "חנות אונליין";
// Sun-Thu 08:00-18:00, Fri 08:00-13:30 in Israel: an automatic order never reaches a supplier's phone at night or on Saturday.
export function workHours(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  const hm = Number(p.hour) * 100 + Number(p.minute);
  return p.weekday !== "Sat" && hm >= 800 && hm <= (p.weekday === "Fri" ? 1330 : 1800);
}
// A paid store order becomes one supplier order per supplier. Safe to call again: the row is claimed once (po_state), and a
// supplier that already has an order for this store order is skipped.
export async function shopOrder(orderId: number, hours = workHours()): Promise<Record<string, unknown>> {
  if (!Number.isInteger(orderId) || orderId <= 0) return { ok: false, error: "bad order" };
  if (!hours) return { ok: true, later: true };
  const now = new Date().toISOString();
  const { data: o } = await admin.from("shop_orders").update({ po_state: "creating", po_at: now }).eq("id", orderId).eq("status", "paid").eq("test", false).is("po_state", null).select("id, items, phone").maybeSingle();
  if (!o) return { ok: true, skipped: true };
  const sent: string[] = [], manual: string[] = [];
  try {
    const qty = new Map<number, number>();
    for (const i of (o.items || []) as any[]) { const id = Number(i?.id), q = Number(i?.qty); if (Number.isInteger(id) && q > 0) qty.set(id, r2((qty.get(id) || 0) + q)); }
    const { data: prices } = await admin.from("sp_prices").select("id, supplier_id, supplier_code, description, size").in("id", [...qty.keys()]);
    const rows = (prices || []) as any[];
    const lost = [...qty.keys()].filter((id) => !rows.some((p) => Number(p.id) === id));
    if (lost.length) manual.push(`${lost.length} פריטים בהזמנה לא נמצאו במחירון הספקים, להזמין ידנית`);
    const codes = [...new Set(rows.map((p) => String(p.supplier_code || "")).filter(Boolean))];
    const { data: stock } = codes.length ? await admin.rpc("crm_stock_sys", { p_codes: codes }) : { data: [] };
    const have = new Map(((stock || []) as any[]).map((x) => [String(x.code), Number(x.available)]));
    const { data: old } = await admin.from("crm_po").select("supplier_id, po_no").eq("shop_order_id", o.id);
    const placed = new Map(((old || []) as any[]).map((x) => [String(x.supplier_id), String(x.po_no)]));
    const bySup = new Map<string, any[]>();
    for (const p of rows) bySup.set(p.supplier_id, [...(bySup.get(p.supplier_id) || []), p]);
    const { data: sups } = await admin.from("sp_suppliers").select("id, name, order_email, order_contact, order_cc, order_wa_phone, order_paused, active").in("id", [...bySup.keys()]);
    const item = (p: any) => `${p.supplier_code || ""} ${p.description || ""}${p.size ? " " + p.size : ""} × ${qty.get(Number(p.id))}`.replace(/\s+/g, " ").trim();
    for (const [sid, list] of bySup) {
      const sup: any = ((sups || []) as any[]).find((x) => x.id === sid);
      const name = sup?.name || "ספק";
      const inStock = list.filter((p) => (have.get(String(p.supplier_code || "")) ?? 0) >= qty.get(Number(p.id))!);
      const need = list.filter((p) => !inStock.includes(p));
      if (inStock.length) manual.push(`במלאי לפי פריוריטי, לא הוזמן מ${name}. לבדוק במדף ולהכין: ${inStock.map(item).join("; ")}`);
      if (!need.length) continue;
      if (placed.has(sid)) { sent.push(`${placed.get(sid)} ${name}`); continue; }
      const todo = `להזמין ידנית מ${name}: ${need.map(item).join("; ")}`;
      if (!sup || !sup.active || (!sup.order_email && !tail9(sup.order_wa_phone))) { manual.push(`אין איש קשר להזמנות. ${todo}`); continue; }
      if (sup.order_paused) { manual.push(`ההזמנות לספק מושהות. ${todo}`); continue; }
      const out = await placePo(sup, new Map(need.map((p) => [Number(p.id), qty.get(Number(p.id))!])), { customerName: "הזמנת אתר " + o.id, customerT9: tail9(o.phone) || null, deliver: null, note: null, by: SHOP_BY, byName: SHOP_BY, shopOrderId: Number(o.id) }, now);
      if (out.po && out.po.status !== "failed") sent.push(`${out.po.po_no} ${name}`);
      if (!out.ok) manual.push(out.po ? `הזמנה ${out.po.po_no} ל${name} לא יצאה: ${out.error}. ${todo}` : `${out.error}. ${todo}`);
      else if (out.warn) manual.push(`הזמנה ${out.po!.po_no} ל${name}: הוואטסאפ לא יצא (${out.warn}), המייל יוצא`);
    }
  } catch (e) {
    console.error("shop order", o.id, e);
    manual.push("שגיאה בפתיחת ההזמנות לספקים, לבדוק בלשונית הזמנות לספקים מה נשלח: " + String(e).slice(0, 150));
  }
  if (manual.length) await admin.from("crm_tasks").insert({ tail9: tail9(o.phone) || null, text: (`הזמנת אתר ${o.id}: ` + manual.join(" | ")).slice(0, 900), due: now, by: SHOP_BY });
  const note = [sent.length ? "נשלח לספק: " + sent.join(", ") : "", ...manual].filter(Boolean).join(" | ").slice(0, 600);
  await admin.from("shop_orders").update({ po_state: manual.length ? "manual" : "done", po_note: note || null, po_at: now }).eq("id", o.id);
  return { ok: true, order: o.id, sent, manual };
}
// From the outbox (every 5 minutes): orders the paid trigger's call missed or that waited for working hours, and an order
// stuck half way (the function died): that one is not retried, staff check what went out.
async function shopSweep(now: string) {
  if (!workHours()) return;
  const stale = new Date(Date.now() - 10 * 60e3).toISOString();
  const { data: stuck } = await admin.from("shop_orders").update({ po_state: "manual", po_note: "לא ברור אילו הזמנות לספקים נשלחו, לבדוק בלשונית הזמנות לספקים", po_at: now }).eq("po_state", "creating").lt("po_at", stale).select("id, phone");
  for (const o of (stuck || []) as any[]) await admin.from("crm_tasks").insert({ tail9: tail9(o.phone) || null, text: `הזמנת אתר ${o.id}: לא ברור אילו הזמנות לספקים נשלחו. לבדוק בלשונית הזמנות לספקים ולהשלים ידנית מה שחסר.`, due: now, by: SHOP_BY });
  const { data: wait } = await admin.from("shop_orders").select("id").eq("status", "paid").eq("test", false).is("po_state", null).order("id").limit(5);
  for (const o of (wait || []) as any[]) await shopOrder(Number(o.id));
}

async function staffAction(req: Request, body: any) {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u } = await admin.auth.getUser(jwt);
  const email = u?.user?.email?.toLowerCase();
  if (!email) return json(req, { ok: false, error: "לא מחובר" }, 401);
  const { data: staff } = await admin.from("crm_staff").select("email, name").eq("active", true).ilike("email", email).maybeSingle();
  if (!staff) return json(req, { ok: false, error: "לא מורשה" }, 403);
  const now = new Date().toISOString();

  if (body.action === "create") {
    const { data: sup } = await admin.from("sp_suppliers").select("id, name, order_email, order_contact, order_cc, order_wa_phone, order_paused, active").eq("id", String(body.supplier_id || "")).maybeSingle();
    const wa = !!(sup && sup.order_wa_phone && tail9(sup.order_wa_phone));
    const mail = !!(sup && sup.order_email);
    if (!sup || !sup.active || (!mail && !wa)) return json(req, { ok: false, error: "לספק הזה אין מייל או וואטסאפ להזמנות" }, 400);
    if (sup.order_paused) return json(req, { ok: false, error: "ההזמנות לספק הזה מושהות עד שהמחירון יתוקן" }, 409);
    const want = Array.isArray(body.lines) ? body.lines : [];
    if (!want.length || want.length > 60) return json(req, { ok: false, error: "צריך בין שורה אחת ל-60 שורות" }, 400);
    const qtyById = new Map<number, number>();
    for (const l of want) {
      const id = Number(l?.price_id), qty = Number(l?.qty);
      if (!Number.isInteger(id) || !(qty > 0) || qty > 100000) return json(req, { ok: false, error: "כמות לא תקינה" }, 400);
      qtyById.set(id, r2((qtyById.get(id) || 0) + qty));
    }
    const dv = body.deliver && typeof body.deliver === "object" ? body.deliver : {};
    const toCustomer = dv.to === "customer";
    const clip = (v: unknown, n: number) => String(v ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, n);
    const cu = body.customer && typeof body.customer === "object" ? body.customer : {};
    const customerName = clip(cu.name, 80) || (toCustomer ? clip(dv.name, 80) : "") || null;
    const customerT9 = tail9(cu.tail9) || (toCustomer ? tail9(dv.tail9) : "") || null;
    if (!customerName && cu.stock !== true) return json(req, { ok: false, error: "צריך לבחור לקוח להזמנה, או לסמן שהיא למלאי" }, 400);
    const deliver = toCustomer ? { name: clip(dv.name, 80), phone: digits(dv.phone).slice(0, 15), address: clip(dv.address, 160), note: clip(dv.note, 120) || null, tail9: tail9(dv.tail9) || null } : null;
    if (deliver && (!deliver.name || deliver.phone.length < 9 || deliver.address.length < 5)) return json(req, { ok: false, error: "לאספקה לבית הלקוח צריך שם, טלפון וכתובת מלאה" }, 400);
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) || null : null;
    const out = await placePo(sup, qtyById, { customerName, customerT9, deliver, note, by: email, byName: staff.name, ...(Number.isInteger(Number(body.deal_id)) && Number(body.deal_id) > 0 ? { dealId: Number(body.deal_id) } : {}) }, now);
    if (!out.ok) return json(req, { ok: false, ...(out.po ? { po: out.po } : {}), error: out.error }, out.code || 400);
    return json(req, { ok: true, po: out.po, ...(out.warn ? { warn: out.warn } : {}) });
  }

  if (body.action === "price_ask") { const out = await priceAsk(body, email, staff.name); return json(req, out, out.ok ? 200 : 400); }

  if (body.action === "wa_template") {
    if (email !== OWNER) return json(req, { ok: false, error: "רק אביב" }, 403);
    const cfg = await waCfg();
    if (!cfg?.token || !cfg?.waba_id) return json(req, { ok: false, error: "וואטסאפ לא מחובר" }, 503);
    const h = { authorization: `Bearer ${cfg.token}` };
    // three templates: the order, the cancellation notice and the price request. body.which picks one to submit; the answer lists all.
    const DEFS: Record<string, { name: string; text: string; example: string[] }> = {
      order: { name: WA_TEMPLATE, text: WA_TEMPLATE_BODY, example: ["דודי", "Z0002", "MP1009CB צינור פלקס גולד × 2 יח' (₪148.00) · WT-2305 סבוניה × 1 יח' (₪150.00)", "₪298.00"] },
      cancel: { name: WA_CANCEL, text: WA_CANCEL_BODY, example: ["דודי", "Z0002", "₪298.00"] },
      price: { name: WA_PRICE, text: WA_PRICE_BODY, example: ["רימה", "ארון אמבטיה לוטוס · מידה 100 · צבע קפוצ'ינו · כיור אינטגרלי", "ישראל ישראלי", "שיר"] },
    };
    const look = async (name: string) => {
      const ex = await (await fetch(`${GRAPH}/${cfg.waba_id}/message_templates?name=${name}&fields=name,status,category,rejected_reason`, { headers: h })).json().catch(() => ({}));
      const f = (ex.data || []).find((t: any) => t.name === name);
      return { exists: !!f, status: f?.status || null, category: f?.category || null, reason: f?.rejected_reason || null } as Record<string, unknown>;
    };
    const all: Record<string, Record<string, unknown>> = { order: await look(WA_TEMPLATE), cancel: await look(WA_CANCEL), price: await look(WA_PRICE) };
    const which = body.which === "cancel" ? "cancel" : body.which === "price" ? "price" : "order";
    if (body.submit && !all[which].exists) {
      const d = DEFS[which];
      const r = await fetch(`${GRAPH}/${cfg.waba_id}/message_templates`, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({
        name: d.name, language: "he", category: "UTILITY", components: [{ type: "BODY", text: d.text, example: { body_text: [d.example] } }] }) });
      const j = await r.json().catch(() => ({}));
      await admin.from("crm_audit").insert({ who: email, action: "po_wa_template", detail: { which, ok: r.ok, id: j.id || null, status: j.status || null, error: j.error?.message || null } });
      all[which] = { exists: r.ok, status: j.status || null, error: j.error ? (j.error.error_user_msg || j.error.message) : null };
      if (!r.ok) return json(req, { ok: false, ...all.order, templates: all, error: all[which].error });
    }
    return json(req, { ok: true, ...all.order, templates: all });
  }

  const id = Number(body.id);
  if (!Number.isInteger(id)) return json(req, { ok: false, error: "חסר מספר הזמנה" }, 400);
  if (body.action === "cancel") {
    // not sent yet: just stop it, the supplier never heard of it
    const { data: quiet } = await admin.from("crm_po").update({ status: "cancelled", cancelled_at: now, cancelled_by: email, updated_at: now }).eq("id", id).eq("status", "queued").select("id").maybeSingle();
    if (quiet) { await admin.from("crm_audit").insert({ who: email, action: "po_cancel", detail: { id, notified: false } }); return json(req, { ok: true, notified: [] }); }
    const { data: po } = await admin.from("crm_po").select("*").eq("id", id).maybeSingle();
    if (!po) return json(req, { ok: false, error: "ההזמנה לא נמצאה" }, 404);
    if (po.status === "cancelled") return json(req, { ok: false, error: "ההזמנה כבר בוטלה" }, 409);
    if (po.status === "sending" || po.email_state === "sending") return json(req, { ok: false, error: "ההזמנה נשלחת ממש עכשיו. נסו שוב בעוד דקה" }, 409);
    if (po.received_at) return json(req, { ok: false, error: "הסחורה של ההזמנה כבר התקבלה, אי אפשר לבטל מכאן" }, 409);
    const mailWent = !!po.to_email && (po.channel === "email" ? ["sent", "confirmed", "attention"].includes(po.status) : po.email_state === "sent" || po.email_state === "unknown");
    const waWent = !!po.wa_msg_id;
    // mark cancelled first (only once), then tell the supplier
    const patch: Record<string, unknown> = { status: "cancelled", cancelled_at: now, cancelled_by: email, cancel_email_state: mailWent ? "queued" : null, updated_at: now,
      cancel_ack: mailWent || waWent ? "waiting" : null,
      summary: `בוטלה ע"י ${staff.name || email}` };
    if (po.email_state === "queued") patch.email_state = "cancelled"; // the order email never left: do not send it
    const { data: done } = await admin.from("crm_po").update(patch).eq("id", id).in("status", ["sent", "confirmed", "attention", "failed"]).select("id").maybeSingle();
    if (!done) return json(req, { ok: false, error: "אי אפשר לבטל את ההזמנה במצב הזה" }, 409);
    let wa: { ok: boolean; error?: string } | null = null;
    if (waWent) {
      wa = await sendWaCancel(po, email);
      await admin.from("crm_po").update({ cancel_wa_state: wa.ok ? "sent" : "failed", cancel_error: wa.ok ? null : "הודעת הביטול בוואטסאפ לא יצאה: " + wa.error,
        ...(!wa.ok && !mailWent ? { cancel_ack: null } : {}) }).eq("id", id);
    }
    await admin.from("crm_audit").insert({ who: email, action: "po_cancel", detail: { id, po: po.po_no, mail: mailWent, wa: wa ? wa.ok : null } });
    return json(req, { ok: true, notified: [...(mailWent ? ["email"] : []), ...(wa?.ok ? ["whatsapp"] : [])], wa_error: wa && !wa.ok ? wa.error : null, mail: mailWent });
  }
  if (body.action === "mark" && body.status === "cancel_confirmed") {
    const { data: po } = await admin.from("crm_po").select("*").eq("id", id).maybeSingle();
    if (!po || po.status !== "cancelled") return json(req, { ok: false, error: "ההזמנה לא מבוטלת" }, 409);
    await admin.from("crm_po").update({ cancel_ack: "confirmed", cancel_ack_at: now, cancel_confirmed_at: now, cancel_summary: `אישור הביטול סומן ידנית ע"י ${staff.name || email}`, updated_at: now }).eq("id", id);
    await closeNudge(po, "cancel");
    await admin.from("crm_audit").insert({ who: email, action: "po_mark", detail: { id, status: "cancel_confirmed" } });
    return json(req, { ok: true });
  }
  if (body.action === "mark") {
    const st = String(body.status);
    if (!["confirmed", "attention", "sent"].includes(st)) return json(req, { ok: false, error: "סטטוס לא מוכר" }, 400);
    const patch: Record<string, unknown> = { status: st, updated_at: now, summary: `סומן ידנית ע"י ${staff.name || email}` };
    if (st === "confirmed") patch.confirmed_at = now;
    const { data } = await admin.from("crm_po").update(patch).eq("id", id).in("status", ["sent", "confirmed", "attention", "failed"]).select("id").maybeSingle();
    if (!data) return json(req, { ok: false, error: "אי אפשר לסמן הזמנה שעוד לא נשלחה" }, 409);
    if (st === "confirmed") { const { data: po } = await admin.from("crm_po").select("nudge_task_id").eq("id", id).maybeSingle(); if (po) await closeNudge(po, "order"); }
    await admin.from("crm_audit").insert({ who: email, action: "po_mark", detail: { id, status: st } });
    return json(req, { ok: true });
  }
  return json(req, { ok: false, error: "פעולה לא מוכרת" }, 400);
}

async function bridgeAction(req: Request, body: any) {
  const now = new Date().toISOString();
  if (body.action === "outbox") {
    try { await shopSweep(now); } catch (e) { console.error("shop sweep", e); }
    const stale = new Date(Date.now() - 20 * 60e3).toISOString();
    await admin.from("crm_po").update({ status: "attention", error: "לא ברור אם המייל נשלח. לבדוק בתיבת דואר יוצא לפני שליחה חוזרת.", updated_at: now })
      .eq("status", "sending").eq("channel", "email").lt("claimed_at", stale);
    await admin.from("crm_po").update({ email_state: "unknown", error: "לא ברור אם המייל נשלח (הוואטסאפ כן). לבדוק בתיבת דואר יוצא.", updated_at: now })
      .eq("email_state", "sending").eq("channel", "both").lt("claimed_at", stale);
    const { data: claimed1 } = await admin.from("crm_po").update({ status: "sending", claimed_at: now, updated_at: now }).eq("status", "queued").eq("channel", "email").select("*");
    const { data: claimed2 } = await admin.from("crm_po").update({ email_state: "sending", claimed_at: now, updated_at: now }).eq("email_state", "queued").eq("channel", "both").neq("status", "cancelled").select("*");
    const claimed = [...(claimed1 || []), ...(claimed2 || [])];
    const orders = claimed.map((po: Po) => ({ id: po.id, po_no: po.po_no, to: po.to_email, cc: po.cc || [], ...renderEmail(po) }));
    // cancellation notices: the same sender, reported back with a negative id
    await admin.from("crm_po").update({ cancel_email_state: "unknown", cancel_error: "לא ברור אם מייל הביטול נשלח. לבדוק בתיבת דואר יוצא.", updated_at: now }).eq("cancel_email_state", "sending").lt("cancel_claimed_at", stale);
    const { data: canc } = await admin.from("crm_po").update({ cancel_email_state: "sending", cancel_claimed_at: now, updated_at: now }).eq("cancel_email_state", "queued").eq("status", "cancelled").select("*");
    for (const po of (canc || []) as Po[]) orders.push({ id: -po.id, po_no: po.po_no, to: po.to_email, cc: po.cc || [], ...renderCancelEmail(po) });
    // the online store's order confirmations to customers ride the same sender (ids above SHOP_BASE)
    try { orders.push(...(await shopOutbox(admin, now))); } catch (e) { console.error("shop outbox", e); }
    return json(req, { ok: true, orders });
  }
  const id = Number(body.id);
  if (id > SHOP_BASE && (body.action === "sent" || body.action === "send_failed")) return json(req, { ok: await shopMailResult(admin, id, body.action === "sent", body, now) });
  if (body.action === "watch") {
    const since = new Date(Date.now() - 45 * 864e5).toISOString();
    const { data } = await admin.from("crm_po").select("id, gmail_thread_id, gmail_msg_id, replies").in("status", ["sent", "attention", "confirmed"]).in("channel", ["email", "both"]).not("gmail_thread_id", "is", null).gt("sent_at", since).limit(100);
    const { data: canc } = await admin.from("crm_po").select("id, gmail_thread_id, gmail_msg_id, cancel_thread_id, cancel_msg_id, replies").eq("status", "cancelled").in("cancel_ack", ["waiting", "attention"]).gt("cancelled_at", since).limit(100);
    const seen = (o: Po) => [o.gmail_msg_id, o.cancel_msg_id, ...(o.replies || []).map((x: any) => x.msg_id)].filter(Boolean);
    const out = (data || []).map((o: Po) => ({ id: o.id, thread_id: o.gmail_thread_id, seen: seen(o) }));
    for (const o of (canc || []) as Po[]) {
      if (o.gmail_thread_id) out.push({ id: o.id, thread_id: o.gmail_thread_id, seen: seen(o) });   // an answer on the order thread
      if (o.cancel_thread_id) out.push({ id: -o.id, thread_id: o.cancel_thread_id, seen: seen(o) }); // an answer on the cancellation mail
    }
    return json(req, { ok: true, orders: out });
  }
  if (!Number.isInteger(id)) return json(req, { ok: false, error: "missing id" }, 400);
  if (id < 0 && (body.action === "sent" || body.action === "send_failed")) {
    const patch = body.action === "sent" ? { cancel_email_state: "sent", cancel_thread_id: String(body.thread_id || "") || null, cancel_msg_id: String(body.msg_id || "") || null, updated_at: now } : { cancel_email_state: "failed", cancel_error: ("מייל הביטול נכשל: " + String(body.error || "")).slice(0, 300), updated_at: now };
    const { data } = await admin.from("crm_po").update(patch).eq("id", -id).in("cancel_email_state", ["sending", "unknown"]).select("id").maybeSingle();
    return json(req, { ok: !!data });
  }
  if (body.action === "sent" || body.action === "send_failed") {
    const { data: cur } = await admin.from("crm_po").select("id, channel, status, error").eq("id", id).maybeSingle();
    if (cur?.channel === "both") {
      if (body.action === "sent") {
        const patch: Record<string, unknown> = { email_state: "sent", gmail_thread_id: String(body.thread_id || "") || null, gmail_msg_id: String(body.msg_id || "") || null, updated_at: now };
        if (cur.status === "failed") Object.assign(patch, { status: "sent", sent_at: now }); // WhatsApp failed, the email went out: now waiting for him
        const { data } = await admin.from("crm_po").update(patch).eq("id", id).in("email_state", ["sending", "unknown"]).select("id").maybeSingle();
        return json(req, { ok: !!data });
      }
      await admin.from("crm_po").update({ email_state: "failed", error: ("המייל נכשל: " + String(body.error || "")).slice(0, 300), updated_at: now }).eq("id", id).eq("email_state", "sending");
      return json(req, { ok: true });
    }
  }
  if (body.action === "sent") {
    const { data } = await admin.from("crm_po").update({ status: "sent", sent_at: now, gmail_thread_id: String(body.thread_id || "") || null, gmail_msg_id: String(body.msg_id || "") || null, error: null, updated_at: now })
      .eq("id", id).in("status", ["sending", "attention"]).select("id").maybeSingle();
    return json(req, { ok: !!data });
  }
  if (body.action === "send_failed") {
    await admin.from("crm_po").update({ status: "failed", error: String(body.error || "").slice(0, 300) || "שליחה נכשלה", updated_at: now }).eq("id", id).eq("status", "sending");
    return json(req, { ok: true });
  }
  if (body.action === "reply") {
    const { data: po } = await admin.from("crm_po").select("*").eq("id", Math.abs(id)).maybeSingle();
    if (!po) return json(req, { ok: false, error: "no order" }, 404);
    const msgId = String(body.msg_id || "");
    if (!msgId || (po.replies || []).some((x: any) => x.msg_id === msgId) || msgId === po.gmail_msg_id || msgId === po.cancel_msg_id) return json(req, { ok: true, dup: true, forward: false });
    const from = String(body.from || "").slice(0, 200);
    const addr = ((from.match(/<([^>]+)>/) || [])[1] || from).trim().toLowerCase();
    // the supplier side: the order address's domain, or a supplier cc such as Dior's sales agent (never our own team)
    const supplierCc = ((po.cc || []) as string[]).map((e) => e.toLowerCase()).filter((e) => !TEAM_CC.includes(e));
    const fromSupplier = (domainOf(from) !== "" && domainOf(from) === domainOf(po.to_email)) || supplierCc.includes(addr);
    const text = newPart(String(body.text || ""));
    const at = body.date && !isNaN(Date.parse(body.date)) ? new Date(body.date).toISOString() : now;
    const entry: Record<string, unknown> = { msg_id: msgId, from, at, text };
    const patch: Record<string, unknown> = { updated_at: now };
    if (!fromSupplier || (po.status === "cancelled" && !awaitingCancel(po))) {
      entry.ignored = true;
    } else if (po.status === "cancelled") {
      const c = await classify(po, text, fetch, "cancel");
      entry.verdict = c.verdict; entry.summary = c.summary; entry.kind = "cancel";
      Object.assign(patch, cancelPatch(c, at, now));
      if (c.verdict !== "auto") await closeNudge(po, "cancel");
    } else {
      const c = await classify(po, text);
      if (c.verdict !== "auto") await closeNudge(po, "order");
      entry.verdict = c.verdict; entry.summary = c.summary;
      if (c.verdict !== "auto") {
        patch.verdict = c.verdict; patch.summary = c.summary; patch.reply_at = at;
        patch.status = c.verdict === "confirmed" ? "confirmed" : "attention";
        if (c.verdict === "confirmed") patch.confirmed_at = now;
      }
    }
    patch.replies = [...(po.replies || []), entry];
    await admin.from("crm_po").update(patch).eq("id", po.id);
    return json(req, { ok: true, forward: fromSupplier, status: patch.status || po.status, cancel_ack: patch.cancel_ack || po.cancel_ack || null });
  }
  return json(req, { ok: false, error: "unknown action" }, 400);
}

// A question to the supplier's order contact on WhatsApp. Never opens a conversation: without a message from the supplier
// in the last 24 hours it is refused (a template would be needed).
export async function waAsk(body: any) {
  const text = String(body.text || "").trim().slice(0, 1500);
  const by = String(body.by || "").trim().slice(0, 80) || "crm-po";
  const { data: sup } = await admin.from("sp_suppliers").select("id, name, order_wa_phone, active").eq("id", String(body.supplier_id || "")).maybeSingle();
  const t9 = tail9(sup?.order_wa_phone);
  if (!sup || !sup.active || !t9) return { ok: false, error: "no whatsapp order contact for this supplier" };
  if (text.length < 5) return { ok: false, error: "empty text" };
  const cfg = await waCfg();
  if (!cfg?.token || !cfg?.phone_number_id) return { ok: false, error: "whatsapp not connected" };
  if (!(await windowOpen(t9))) return { ok: false, error: "window closed: the supplier has not written in the last 24 hours" };
  let to = digits(sup.order_wa_phone); if (to.startsWith("0")) to = "972" + to.slice(1);
  const res = await waPost(cfg, { messaging_product: "whatsapp", to, type: "text", text: { body: text, preview_url: false } });
  if (!res.ok || !res.id) return { ok: false, error: (res.error || "error").slice(0, 250) };
  await waRecord({ to_phone: sup.order_wa_phone, supplier_name: sup.name, po_no: null }, res.id, "text", text, by, { ask: true });
  await admin.from("crm_audit").insert({ who: by, action: "po_wa_ask", detail: { supplier: sup.name, wamid: res.id, text } });
  return { ok: true, id: res.id };
}

// A price request from an order line to a supplier that prices on request. A staff member pressed the button: that is the yes.
// It carries the model, size, colour and the customer's name, nothing else about the customer.
export async function priceAsk(body: any, email: string, staffName: string | null) {
  const flat = (t: unknown, n: number) => String(t ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, n);
  const model = flat(body.model, 200), size = flat(body.size, 60), color = flat(body.color, 60), note = flat(body.note, 200);
  if (model.length < 2) return { ok: false, error: "חסר דגם או תיאור" };
  const { data: deal } = await admin.from("crm_deals").select("id, deal_no, customer_name").eq("id", Number(body.deal_id) || 0).maybeSingle();
  if (!deal) return { ok: false, error: "ההזמנה לא נמצאה" };
  const { data: sup } = await admin.from("sp_suppliers").select("id, name, order_wa_phone, order_contact, active, price_by_ask").eq("id", String(body.supplier_id || "")).maybeSingle();
  const t9 = tail9(sup?.order_wa_phone);
  if (!sup || !sup.active || !sup.price_by_ask || !t9) return { ok: false, error: "לספק הזה אין בקשת מחיר בוואטסאפ" };
  const who = flat(staffName || "צוות זיסו", 40), contact = flat(sup.order_contact, 40), customer = flat(deal.customer_name, 60) || "לקוח";
  const item = [model, size && "מידה " + size, color && "צבע " + color, note].filter(Boolean).join(" · ");
  const text = ["שלום" + (contact ? " " + contact : "") + ", בקשת מחיר מזיסו קרמיקה:", model, ...(size ? ["מידה: " + size] : []), ...(color ? ["צבע: " + color] : []), ...(note ? [note] : []),
    "עבור לקוח: " + customer, "", "נשמח למחיר ולזמן אספקה. תודה, " + who].join("\n");
  const cfg = await waCfg();
  let res: { ok: boolean; id?: string; error: string } = { ok: false, error: "וואטסאפ לא מחובר" }, via = "text";
  if (cfg?.token && cfg?.phone_number_id) {
    let to = digits(sup.order_wa_phone); if (to.startsWith("0")) to = "972" + to.slice(1);
    if (await windowOpen(t9)) res = await waPost(cfg, { messaging_product: "whatsapp", to, type: "text", text: { body: text, preview_url: false } });
    else {
      via = "template";
      res = await waPost(cfg, { messaging_product: "whatsapp", to, type: "template", template: { name: WA_PRICE, language: { code: "he" },
        components: [{ type: "body", parameters: [contact || "שלום", item.slice(0, 600), customer, who].map((x) => ({ type: "text", text: x })) }] } });
      if (!res.ok && /template|132\d{3}/i.test(res.error)) res.error = "תבנית בקשת המחיר עוד לא מאושרת במטא, אז אי אפשר לפתוח שיחה עם הספק. אפשר לשלוח כשהספק כתב לנו ב-24 השעות האחרונות.";
    }
  }
  if (res.ok && res.id) await waRecord({ to_phone: sup.order_wa_phone, supplier_name: sup.name, po_no: null }, res.id, via, text, email, { ask: true, deal: deal.deal_no, ...(via === "template" ? { template: WA_PRICE } : {}) });
  const { data: ask } = await admin.from("crm_price_asks").insert({ deal_id: deal.id, lid: flat(body.lid, 40) || null, supplier_id: sup.id, item, customer_name: customer, text, by: email, by_name: who,
    via, wa_msg_id: res.id || null, state: res.ok ? "sent" : "failed", error: res.ok ? null : (res.error || "error").slice(0, 300) }).select("*").maybeSingle();
  await admin.from("crm_audit").insert({ who: email, action: "price_ask", detail: { supplier: sup.name, deal: deal.deal_no, ok: res.ok, via, wamid: res.id || null } });
  return res.ok ? { ok: true, ask } : { ok: false, ask, error: res.error || "לא נשלח" };
}

// A WhatsApp message from the supplier contact (trigger crm_po_wa_in on wa_messages).
export async function waReply(body: any) {
  const now = new Date().toISOString();
  const id = Number(body.id);
  let { data: po } = await admin.from("crm_po").select("*").eq("id", id).in("channel", ["whatsapp", "both"]).maybeSingle();
  if (!po) return { ok: false, error: "no order" };
  // he named another order number of his (e.g. "Z0007 מאושר"): the answer belongs to that one
  const named = (String(body.text || "").match(/\b[zZ]\s?(\d{4})\b/) || [])[1];
  if (named && "Z" + named !== po.po_no) {
    const { data: other } = await admin.from("crm_po").select("*").eq("po_no", "Z" + named).in("channel", ["whatsapp", "both"]).maybeSingle();
    if (other && tail9(other.to_phone) === tail9(po.to_phone)) po = other;
  }
  const msgId = String(body.msg_id || "");
  if (!msgId || msgId === po.wa_msg_id || (po.replies || []).some((x: any) => x.msg_id === msgId)) return { ok: true, dup: true };
  const wid = po.id;
  if (tail9(body.from) !== tail9(po.to_phone)) return { ok: false, error: "not the supplier" };
  const text = String(body.text || "").trim().slice(0, 3000);
  const at = body.date && !isNaN(Date.parse(body.date)) ? new Date(body.date).toISOString() : now;
  const entry: Record<string, unknown> = { msg_id: msgId, from: String(body.from || ""), at, text, channel: "whatsapp" };
  const patch: Record<string, unknown> = { updated_at: now };
  const firstAnswer = !(po.replies || []).some((x: any) => !x.ignored);
  if (!text || (po.status === "cancelled" && !awaitingCancel(po))) {
    entry.ignored = true; // a file or sticker: not an answer to the order
  } else if (po.status === "cancelled") {
    const c = await classify(po, text, fetch, "cancel");
    entry.verdict = c.verdict; entry.summary = c.summary; entry.kind = "cancel";
    Object.assign(patch, cancelPatch(c, at, now));
    if (c.verdict !== "auto") await closeNudge(po, "cancel");
  } else {
    if (po.wa_truncated && firstAnswer) {
      // the template held only part of the lines; now that he wrote, the 24h window is open: send the full order
      const cfg = await waCfg();
      if (cfg?.token) {
        let to = digits(po.to_phone); if (to.startsWith("0")) to = "972" + to.slice(1);
        const full = waFullText(po);
        const r = await waPost(cfg, { messaging_product: "whatsapp", to, type: "text", text: { body: full.slice(0, 4000), preview_url: false } });
        if (r.ok && r.id) await waRecord(po, r.id, "text", full, "crm-po");
      }
    }
    const c = await classify(po, text);
    entry.verdict = c.verdict; entry.summary = c.summary;
    if (c.verdict !== "auto") await closeNudge(po, "order");
    if (c.verdict !== "auto") {
      let verdict = c.verdict, summary = c.summary;
      if (verdict === "confirmed" && po.wa_truncated && firstAnswer) { verdict = "unclear"; summary = "אישר את ההודעה המקוצרת. נשלח לו הפירוט המלא, לוודא שאישר את כל השורות"; }
      patch.verdict = verdict; patch.summary = summary; patch.reply_at = at;
      patch.status = verdict === "confirmed" ? "confirmed" : "attention";
      if (verdict === "confirmed") patch.confirmed_at = now;
    }
  }
  patch.replies = [...(po.replies || []), entry];
  await admin.from("crm_po").update(patch).eq("id", wid);
  return { ok: true, status: patch.status || po.status, cancel_ack: patch.cancel_ack || po.cancel_ack || null };
}

// Read only, hook token (database function crm_wa_templates): where our three supplier templates stand at Meta.
// Names and statuses only. Nothing is submitted here: submitting a template stays the owner's own click.
async function waTemplates() {
  const cfg = await waCfg();
  if (!cfg?.token || !cfg?.waba_id) return { ok: false, error: "וואטסאפ לא מחובר" };
  const out: Record<string, unknown> = {};
  for (const name of [WA_TEMPLATE, WA_CANCEL, WA_PRICE]) {
    const r = await fetch(`${GRAPH}/${cfg.waba_id}/message_templates?name=${name}&fields=name,status,category,rejected_reason`, { headers: { authorization: `Bearer ${cfg.token}` } });
    const ex = await r.json().catch(() => ({}));
    const f = (ex.data || []).find((t: any) => t.name === name);
    out[name] = f ? { exists: true, status: f.status, category: f.category, reason: f.rejected_reason || null }
      : { exists: false, http: r.status, error: ex.error ? String(ex.error.message || "").slice(0, 160) : null };
  }
  return { ok: true, templates: out };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
  if (req.method !== "POST") return json(req, { ok: false, error: "POST only" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json(req, { ok: false, error: "bad json" }, 400); }
  try {
    const hk = req.headers.get("x-hook-token");
    if (hk) {
      const { data: keys } = await admin.from("crm_push_keys").select("hook_token").eq("id", 1).maybeSingle();
      if (!keys?.hook_token || hk !== keys.hook_token) return json(req, { ok: false, error: "forbidden" }, 403);
      if (body?.action === "wa_templates") return json(req, await waTemplates());
      if (body?.action !== "wa_reply" && body?.action !== "wa_ask" && body?.action !== "shop_order") return json(req, { ok: false, error: "unknown action" }, 400);
      const out: any = body.action === "shop_order" ? await shopOrder(Number(body.order_id)) : body.action === "wa_ask" ? await waAsk(body) : await waReply(body);
      return json(req, out, out.ok ? 200 : 400);
    }
    const k = req.headers.get("x-import-key");
    if (k) {
      if ((await sha256(k)) !== IMPORT_SHA256) return json(req, { ok: false, error: "forbidden" }, 403);
      return await bridgeAction(req, body || {});
    }
    return await staffAction(req, body || {});
  } catch (e) {
    return json(req, { ok: false, error: String(e).slice(0, 300) }, 500);
  }
});
