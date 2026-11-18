// The store's order confirmation mail (Aviv 18.11.2026: "קבלה למייל, מעוצב בסגנון זיסו").
// Queued by the shop_order_paid trigger (shop_orders.mail_state = 'queued') once Tranzila confirms the money, and sent by the
// Gmail bridge through crm-po's outbox, with ids above SHOP_BASE so SupplierOrders.gs needs no change.
// It confirms the order and the payment. The tax invoice / receipt itself is issued by the accounting system and sent separately.
// A test order's mail goes to the staff member who made it, never to the address typed in the form.
type Db = { from: (t: string) => any };
type Order = Record<string, any>;
export const SHOP_BASE = 1_000_000_000;
const SITE = "https://www.zisoceramics.com";
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const ils = (n: number) => "₪" + Number(n).toLocaleString("he-IL", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export function renderShopMail(o: Order, lead: string) {
  const items = (o.items || []) as { code?: string; name: string; size?: string; qty: number; price: number }[];
  const first = String(o.name || "").trim().split(/\s+/)[0] || "";
  const day = new Date(o.created_at).toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem" });
  const ship = o.delivery === "delivery";
  const subject = `זיסו קרמיקה - אישור הזמנה ${o.id}${o.test ? " (בדיקה)" : ""}`;
  const how = ship ? `משלוח עד הבית: ${[o.address, o.city].filter(Boolean).join(", ")}` : "איסוף עצמי מאולם התצוגה, עוצמה 5 טירת כרמל";
  const next = ship
    ? `ההזמנה תגיע אליכם עם חברת שליחויות ${lead}. נעדכן אתכם בטלפון לפני המסירה.`
    : `ההזמנה תהיה מוכנה לאיסוף ${lead}. נתקשר לתאם איתכם כשהיא מחכה לכם.`;
  const paid = o.test ? `זו הזמנת בדיקה: חויבו ${ils(o.charged)} בלבד.` : `התשלום בסך ${ils(o.total)} התקבל בכרטיס אשראי.`;
  const c = { bg: "#f6f4ef", card: "#ffffff", line: "#ddd6c8", ink: "#1e1b17", mute: "#5f5a52", brass: "#8a6a35", soft: "#efeae0" };
  const serif = `'Times New Roman',Georgia,serif`, sans = `Assistant,'Segoe UI',Arial,sans-serif`;
  const td = `padding:12px 0;border-bottom:1px solid ${c.line};font-family:${sans};font-size:15px;color:${c.ink};vertical-align:top`;
  const rows = items.map((i) => `<tr><td style="${td};text-align:right">${esc(i.name)}${i.size ? " " + esc(i.size) : ""}${i.code ? `<br><span dir="ltr" style="color:${c.mute};font-size:13px">${esc(i.code)}</span>` : ""}</td><td style="${td};text-align:center;white-space:nowrap;padding-left:10px;padding-right:10px">${Number(i.qty)} ×</td><td style="${td};text-align:left;white-space:nowrap">${ils(i.price * i.qty)}</td></tr>`).join("");
  const sum = (label: string, v: string, bold = false) => `<tr><td colspan="2" style="padding:${bold ? "14px" : "8px"} 0 0;font-family:${sans};font-size:${bold ? "18px" : "15px"};color:${bold ? c.ink : c.mute};text-align:right${bold ? ";font-weight:700" : ""}">${label}</td><td style="padding:${bold ? "14px" : "8px"} 0 0;font-family:${sans};font-size:${bold ? "18px" : "15px"};color:${bold ? c.ink : c.mute};text-align:left;white-space:nowrap${bold ? ";font-weight:700" : ""}">${v}</td></tr>`;
  const box = (title: string, body: string) => `<td style="background:${c.soft};border-radius:10px;padding:14px 16px;font-family:${sans};font-size:15px;color:${c.ink};text-align:right;vertical-align:top"><div style="color:${c.brass};font-size:13px;font-weight:700;margin-bottom:4px">${title}</div>${body}</td>`;
  const html = `<!doctype html><html lang="he" dir="rtl"><body style="margin:0;padding:0;background:${c.bg}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${c.bg}" dir="rtl"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px" dir="rtl">
<tr><td align="center" style="padding:6px 0 18px"><img src="${SITE}/img/logo.jpg" width="64" height="64" alt="" style="border-radius:50%;display:block;margin:0 auto 8px"><div style="font-family:${serif};font-size:28px;letter-spacing:.03em;color:${c.ink}">זיסו קרמיקה</div><div style="font-family:${sans};font-size:13px;color:${c.mute}">מאז 1985 · טירת כרמל</div></td></tr>
<tr><td style="background:${c.card};border:1px solid ${c.line};border-radius:14px;padding:28px 24px">
<div style="height:3px;width:44px;background:${c.brass};margin:0 0 16px"></div>
<h1 style="margin:0 0 8px;font-family:${serif};font-weight:400;font-size:30px;line-height:1.15;color:${c.ink};text-align:right">תודה${first ? " " + esc(first) : ""}, ההזמנה התקבלה</h1>
<p style="margin:0 0 20px;font-family:${sans};font-size:16px;line-height:1.5;color:${c.mute};text-align:right">הזמנה מספר <b style="color:${c.ink}">${Number(o.id)}</b> מיום ${esc(day)}. ${esc(paid)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="rtl" style="border-top:1px solid ${c.line}">${rows}
${ship ? sum("משלוח", ils(o.delivery_fee)) : ""}${sum('סה"כ כולל מע"מ', ils(o.total), true)}</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="rtl" style="margin-top:22px"><tr>${box(ship ? "משלוח" : "איסוף", esc(how))}</tr><tr><td style="height:10px"></td></tr><tr>${box("מה עכשיו", esc(next))}</tr></table>
<p style="margin:20px 0 0;font-family:${sans};font-size:14px;line-height:1.55;color:${c.mute};text-align:right">חשבונית מס / קבלה תישלח אליכם בנפרד. לביטול עסקה ולהחזרות: <a href="${SITE}/shop/terms.html" style="color:${c.brass}">תקנון החנות</a>.</p>
</td></tr>
<tr><td align="center" style="padding:20px 8px 6px;font-family:${sans};font-size:14px;line-height:1.6;color:${c.mute}">שאלה על ההזמנה? אנחנו כאן: <a href="tel:0504770040" style="color:${c.brass}" dir="ltr">050-4770040</a> · <a href="mailto:info@zisoceramics.com" style="color:${c.brass}">info@zisoceramics.com</a><br><a href="${SITE}/" style="color:${c.brass}">zisoceramics.com</a> · זיסו קרמיקה בע"מ · ח.פ. 517079661 · עוצמה 5, טירת כרמל<br>א׳-ה׳ 08:00-18:00 · ו׳ 08:00-13:30</td></tr>
</table></td></tr></table></body></html>`;
  const text = [`תודה${first ? " " + first : ""}, ההזמנה התקבלה.`, `הזמנה מספר ${o.id} מיום ${day}. ${paid}`, "",
    ...items.map((i) => `${i.qty} × ${i.name}${i.size ? " " + i.size : ""}${i.code ? " (" + i.code + ")" : ""} - ${ils(i.price * i.qty)}`),
    ...(ship ? [`משלוח - ${ils(o.delivery_fee)}`] : []), `סה"כ כולל מע"מ: ${ils(o.total)}`, "", how, next, "",
    "חשבונית מס / קבלה תישלח אליכם בנפרד.", `תקנון החנות, ביטול עסקה והחזרות: ${SITE}/shop/terms.html`, "",
    "זיסו קרמיקה בע\"מ · עוצמה 5, טירת כרמל · 050-4770040 · info@zisoceramics.com"].join("\n");
  return { subject, html, text };
}

// Claimed once: a mail whose result never came back turns "unknown" after 20 minutes and is never sent twice.
export async function shopOutbox(admin: Db, now: string) {
  const stale = new Date(Date.now() - 20 * 60e3).toISOString();
  await admin.from("shop_orders").update({ mail_state: "unknown" }).eq("mail_state", "sending").lt("mail_claimed_at", stale);
  const { data: claimed } = await admin.from("shop_orders").update({ mail_state: "sending", mail_claimed_at: now }).eq("mail_state", "queued").eq("status", "paid").select("*");
  if (!claimed?.length) return [];
  const { data: st } = await admin.from("shop_settings").select("lead_text").eq("id", 1).maybeSingle();
  return (claimed as Order[]).map((o) => ({ id: SHOP_BASE + Number(o.id), po_no: "shop-" + o.id, to: o.test ? (o.created_by || "info@zisoceramics.com") : o.email, cc: [], ...renderShopMail(o, st?.lead_text || "עד 14 ימי עסקים") }));
}
export async function shopMailResult(admin: Db, id: number, ok: boolean, body: any, now: string) {
  const patch = ok ? { mail_state: "sent", mail_sent_at: now, mail_msg_id: String(body.msg_id || "") || null, mail_error: null } : { mail_state: "failed", mail_error: String(body.error || "").slice(0, 300) || "שליחה נכשלה" };
  const { data } = await admin.from("shop_orders").update(patch).eq("id", id - SHOP_BASE).in("mail_state", ["sending", "unknown"]).select("id").maybeSingle();
  return !!data;
}
