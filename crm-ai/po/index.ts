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
// Priority is never written.
import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { autoRefreshToken: false, persistSession: false } });
const IMPORT_SHA256 = "f34768d670cc85ef42eb41294bd0d101707b94e00ad2659ecf28439dbc6852d0";
const TEAM_CC = ["eilatziso50@gmail.com", "shirziso1605@gmail.com"]; // Aviv 15.11: every order mail and every answer goes to Eilat and Shir too
const MODEL = Deno.env.get("PO_MODEL") || "claude-haiku-5-5";
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
${note}<p><b>נא אשרו את ההזמנה וזמינות הפריטים במייל חוזר.</b> אם פריט חסר או שהמחיר השתנה, נא לציין בתשובה.</p>
<p>תודה,<br>זיסו קרמיקה בע"מ<br>עוצמה 5, טירת כרמל · 050-4770040</p></div>`;
  const text = [hello, "", `מצורפת הזמנת רכש מס' ${po.po_no} מזיסו קרמיקה:`, "",
    ...lines.map((l, i) => `${i + 1}. מק"ט ${l.sku} | ${l.desc}${l.size ? " " + l.size : ""} | כמות ${l.qty}${l.unit ? " " + l.unit : ""} | ${ils(l.price)} ליח' | ${ils(l.total)}`),
    "", `סה"כ לפני מע"מ: ${ils(po.total_cost)}`, "המחירים לפי המחירון שלכם, לפני מע\"מ.",
    ...(po.note ? ["", "הערה: " + po.note] : []),
    "", "נא אשרו את ההזמנה וזמינות הפריטים במייל חוזר. אם פריט חסר או שהמחיר השתנה, נא לציין בתשובה.", "", "תודה,", "זיסו קרמיקה בע\"מ", "עוצמה 5, טירת כרמל · 050-4770040"].join("\n");
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

export async function classify(po: Po, text: string, fetcher: typeof fetch = fetch): Promise<{ verdict: string; summary: string }> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return { verdict: "unclear", summary: "לא הצלחתי לקרוא את התשובה אוטומטית, לבדוק במייל" };
  const items = (po.lines as Line[]).map((l) => `${l.sku} ${l.desc ?? ""} x${l.qty}`).join("; ");
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
  try {
    const r = await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 300, system, messages: [{ role: "user", content: `Order ${po.po_no}: ${items}\n\nSupplier reply:\n${text}` }] }),
    });
    if (!r.ok) throw new Error("api " + r.status);
    const j = await r.json();
    const t = (j.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    const m = t.match(/\{[\s\S]*\}/);
    const o = m ? JSON.parse(m[0]) : {};
    const verdict = ["confirmed", "partial", "question", "rejected", "auto", "unclear"].includes(o.verdict) ? o.verdict : "unclear";
    return { verdict, summary: String(o.summary || "").slice(0, 200) || "לבדוק את התשובה במייל" };
  } catch (_e) {
    return { verdict: "unclear", summary: "לא הצלחתי לקרוא את התשובה אוטומטית, לבדוק במייל" };
  }
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
    const { data: sup } = await admin.from("sp_suppliers").select("id, name, order_email, order_contact, active").eq("id", String(body.supplier_id || "")).maybeSingle();
    if (!sup || !sup.active || !sup.order_email) return json(req, { ok: false, error: "לספק הזה אין מייל להזמנות" }, 400);
    const want = Array.isArray(body.lines) ? body.lines : [];
    if (!want.length || want.length > 60) return json(req, { ok: false, error: "צריך בין שורה אחת ל-60 שורות" }, 400);
    const qtyById = new Map<number, number>();
    for (const l of want) {
      const id = Number(l?.price_id), qty = Number(l?.qty);
      if (!Number.isInteger(id) || !(qty > 0) || qty > 100000) return json(req, { ok: false, error: "כמות לא תקינה" }, 400);
      qtyById.set(id, r2((qtyById.get(id) || 0) + qty));
    }
    const { data: prices } = await admin.from("sp_prices").select("id, supplier_id, supplier_code, description, size, unit, price, currency, vat_included, status").in("id", [...qtyById.keys()]);
    const byId = new Map((prices || []).map((p: any) => [Number(p.id), p]));
    const lines: Line[] = [];
    for (const [id, qty] of qtyById) {
      const p: any = byId.get(id);
      if (!p || p.supplier_id !== sup.id || p.status !== "active") return json(req, { ok: false, error: "פריט לא נמצא במחירון הפעיל של הספק" }, 400);
      if (p.price == null || (p.currency && p.currency !== "ILS")) return json(req, { ok: false, error: `לפריט ${p.supplier_code} אין מחיר בשקלים` }, 400);
      const price = p.vat_included ? r2(Number(p.price) / 1.18) : Number(p.price);
      lines.push({ price_id: id, sku: p.supplier_code, desc: p.description, size: p.size, unit: p.unit, qty, price, total: r2(price * qty) });
    }
    const total = r2(lines.reduce((s, l) => s + l.total, 0));
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) || null : null;
    const { data: po, error } = await admin.from("crm_po").insert({
      supplier_id: sup.id, supplier_name: sup.name, to_email: sup.order_email, cc: TEAM_CC, contact: sup.order_contact, lines, total_cost: total, note,
      status: "queued", by: email, by_name: staff.name, updated_at: now,
    }).select("*").single();
    if (error) return json(req, { ok: false, error: error.message }, 500);
    await admin.from("crm_audit").insert({ who: email, action: "po_create", detail: { id: po.id, po: po.po_no, supplier: sup.name, lines: lines.length, total } });
    return json(req, { ok: true, po });
  }

  const id = Number(body.id);
  if (!Number.isInteger(id)) return json(req, { ok: false, error: "חסר מספר הזמנה" }, 400);
  if (body.action === "cancel") {
    const { data } = await admin.from("crm_po").update({ status: "cancelled", updated_at: now }).eq("id", id).eq("status", "queued").select("id").maybeSingle();
    if (!data) return json(req, { ok: false, error: "ההזמנה כבר נשלחה, אי אפשר לבטל מכאן" }, 409);
    await admin.from("crm_audit").insert({ who: email, action: "po_cancel", detail: { id } });
    return json(req, { ok: true });
  }
  if (body.action === "mark") {
    const st = String(body.status);
    if (!["confirmed", "attention", "sent"].includes(st)) return json(req, { ok: false, error: "סטטוס לא מוכר" }, 400);
    const patch: Record<string, unknown> = { status: st, updated_at: now, summary: `סומן ידנית ע"י ${staff.name || email}` };
    if (st === "confirmed") patch.confirmed_at = now;
    const { data } = await admin.from("crm_po").update(patch).eq("id", id).in("status", ["sent", "confirmed", "attention", "failed"]).select("id").maybeSingle();
    if (!data) return json(req, { ok: false, error: "אי אפשר לסמן הזמנה שעוד לא נשלחה" }, 409);
    await admin.from("crm_audit").insert({ who: email, action: "po_mark", detail: { id, status: st } });
    return json(req, { ok: true });
  }
  return json(req, { ok: false, error: "פעולה לא מוכרת" }, 400);
}

async function bridgeAction(req: Request, body: any) {
  const now = new Date().toISOString();
  if (body.action === "outbox") {
    const stale = new Date(Date.now() - 20 * 60e3).toISOString();
    await admin.from("crm_po").update({ status: "attention", error: "לא ברור אם המייל נשלח. לבדוק בתיבת דואר יוצא לפני שליחה חוזרת.", updated_at: now })
      .eq("status", "sending").lt("claimed_at", stale);
    const { data: claimed } = await admin.from("crm_po").update({ status: "sending", claimed_at: now, updated_at: now }).eq("status", "queued").select("*");
    const orders = (claimed || []).map((po: Po) => ({ id: po.id, po_no: po.po_no, to: po.to_email, cc: po.cc || [], ...renderEmail(po) }));
    return json(req, { ok: true, orders });
  }
  const id = Number(body.id);
  if (body.action === "watch") {
    const since = new Date(Date.now() - 45 * 864e5).toISOString();
    const { data } = await admin.from("crm_po").select("id, gmail_thread_id, gmail_msg_id, replies").in("status", ["sent", "attention", "confirmed"]).not("gmail_thread_id", "is", null).gt("sent_at", since).limit(100);
    return json(req, { ok: true, orders: (data || []).map((o: Po) => ({ id: o.id, thread_id: o.gmail_thread_id, seen: [o.gmail_msg_id, ...(o.replies || []).map((x: any) => x.msg_id)].filter(Boolean) })) });
  }
  if (!Number.isInteger(id)) return json(req, { ok: false, error: "missing id" }, 400);
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
    const { data: po } = await admin.from("crm_po").select("*").eq("id", id).maybeSingle();
    if (!po) return json(req, { ok: false, error: "no order" }, 404);
    const msgId = String(body.msg_id || "");
    if (!msgId || (po.replies || []).some((x: any) => x.msg_id === msgId) || msgId === po.gmail_msg_id) return json(req, { ok: true, dup: true, forward: false });
    const from = String(body.from || "").slice(0, 200);
    const fromSupplier = domainOf(from) !== "" && domainOf(from) === domainOf(po.to_email);
    const text = newPart(String(body.text || ""));
    const at = body.date && !isNaN(Date.parse(body.date)) ? new Date(body.date).toISOString() : now;
    const entry: Record<string, unknown> = { msg_id: msgId, from, at, text };
    const patch: Record<string, unknown> = { updated_at: now };
    if (!fromSupplier || po.status === "cancelled") {
      entry.ignored = true;
    } else {
      const c = await classify(po, text);
      entry.verdict = c.verdict; entry.summary = c.summary;
      if (c.verdict !== "auto") {
        patch.verdict = c.verdict; patch.summary = c.summary; patch.reply_at = at;
        patch.status = c.verdict === "confirmed" ? "confirmed" : "attention";
        if (c.verdict === "confirmed") patch.confirmed_at = now;
      }
    }
    patch.replies = [...(po.replies || []), entry];
    await admin.from("crm_po").update(patch).eq("id", id);
    return json(req, { ok: true, forward: fromSupplier, status: patch.status || po.status });
  }
  return json(req, { ok: false, error: "unknown action" }, 400);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
  if (req.method !== "POST") return json(req, { ok: false, error: "POST only" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json(req, { ok: false, error: "bad json" }, 400); }
  try {
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
