// shop: the online store on zisoceramics.com/shop/ (hidden preview until Aviv says go live).
//   { action: "catalog" }                         -> public product list with VAT-inclusive prices (cost never leaves the database)
//   { action: "checkout", items:[{id,qty}], name, phone, email, delivery, address?, city?, notes?, terms:true, marketing? }
//                                                 -> { pr_link, token }  (Tranzila hosted payment page; we never see card data)
//   { action: "status", token }                   -> the order's state, for the customer's own status page
//   login_start {email} / login_finish {code} / me, cart_save, logout {session} -> the customer account (sign-in link by mail, no password)
//   admin_* (staff JWT, page crm/shop.html): admin_orders, admin_order, admin_products, admin_settings; owner only: admin_item, admin_settings_set
// While shop_settings.live = false: checkout needs a signed-in staff user (Supabase JWT) and every payment is a ₪5 test.
// Prices are recomputed here from shop_catalog() on every checkout; the browser's prices are never trusted.
import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { autoRefreshToken: false, persistSession: false } });
const TERMINAL = "avivziso", OWNER = "avivziso70@gmail.com", BIZ_EMAIL = "info@zisoceramics.com", TEST_SUM = 5;
const ORIGINS = ["https://www.zisoceramics.com", "https://zisoceramics.com", "http://localhost:8000", "http://localhost:8765"];
function cors(req: Request, extra: Record<string, string> = {}) {
  const o = req.headers.get("origin") || "";
  return { "access-control-allow-origin": ORIGINS.includes(o) ? o : ORIGINS[0], "access-control-allow-headers": "authorization, content-type, apikey, x-client-info", "access-control-allow-methods": "POST, OPTIONS", vary: "origin", "content-type": "application/json", ...extra };
}
const json = (req: Request, body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: cors(req, extra) });

const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b as ArrayBuffer)).map((x) => x.toString(16).padStart(2, "0")).join("");
async function hmac(key: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
}
async function tranzila(path: string, body: unknown, scheme: "A" | "B") {
  const app = Deno.env.get("TRANZILA_APP_KEY")!, secret = Deno.env.get("TRANZILA_SECRET")!;
  const time = String(scheme === "A" ? Math.floor(Date.now() / 1000) : Date.now());
  const nonce = hex(crypto.getRandomValues(new Uint8Array(scheme === "A" ? 40 : 20)));
  const token = scheme === "A" ? await hmac(secret + time + nonce, app) : await hmac(secret, app + time + nonce);
  const r = await fetch("https://api.tranzila.com" + path, { method: "POST", headers: { "X-tranzila-api-app-key": app, "X-tranzila-api-request-time": time, "X-tranzila-api-nonce": nonce, "X-tranzila-api-access-token": token, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { http: r.status, j: (await r.json().catch(() => ({}))) as Record<string, any> };
}
const ilDate = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
// Courier fee by what is in the parcel: a kitchen / granite / steel sink is a heavy box, a ceramic basin a big fragile one, the rest a small one.
const parcel = (name: string) => !/(^|\s)כיור/.test(name) || /לכיור/.test(name) ? "" : /(גרניט|נירוסטה|מטבח|פורצלן בעובי)/.test(name) ? "h" : "b";
function shipFee(ship: Record<string, any> | null, lines: { name: string; qty: number }[]) {
  if (!ship) return null;
  let b = 0, h = 0;
  for (const l of lines) { const c = parcel(l.name); if (c === "b") b += l.qty; else if (c === "h") h += l.qty; }
  if (!b && !h) return Number(ship.small);
  return h * Number(ship.heavy) + (b ? Number(ship.sink) + (b - 1) * Number(ship.extra_sink || 0) : 0);
}
// ---- customer account (no password): a device holds a random session secret, the table keeps only its hash ----
const sha = async (t: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)));
const secret = () => hex(crypto.getRandomValues(new Uint8Array(24)));
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
async function customerOf(session: unknown) {
  const t = String(session || "");
  if (!/^[0-9a-f]{48}$/.test(t)) return null;
  const { data: s } = await admin.from("shop_sessions").select("customer_id, expires_at").eq("token_hash", await sha(t)).maybeSingle();
  if (!s || new Date(s.expires_at) < new Date()) return null;
  const { data: c } = await admin.from("shop_customers").select("*").eq("id", s.customer_id).maybeSingle();
  return c as Record<string, any> | null;
}
// verified = the address was proven by a sign-in link. A session opened by a first checkout is not; it ends the day the
const hdPath = (p: string) => "hd/" + p.slice(4); // img/<upload>/<page>-<ref>.jpg -> hd/<upload>/<page>-<ref>.jpg
// address owner signs in by link, so typing someone else's address at checkout never gives a lasting way into their account.
async function newSession(customerId: number, verified = false) {
  const t = secret();
  await admin.from("shop_sessions").insert({ token_hash: await sha(t), customer_id: customerId, verified, expires_at: new Date(Date.now() + 180 * 864e5).toISOString() });
  return t;
}
function cleanCart(v: unknown) {
  const out: Record<string, number> = {};
  if (v && typeof v === "object") for (const [k, q] of Object.entries(v as Record<string, unknown>).slice(0, 80)) if (/^\d{1,12}$/.test(k) && Number.isInteger(Number(q)) && Number(q) > 0) out[k] = Math.min(50, Number(q));
  return out;
}
async function profile(c: Record<string, any>) {
  const { data: orders } = await admin.from("shop_orders").select("id, created_at, status, total, delivery, tracking, courier, items").eq("customer_id", c.id).in("status", ["paid", "sent", "done", "cancelled"]).eq("test", false).order("id", { ascending: false }).limit(20);
  return { email: c.email, name: c.name, phone: c.phone, address: c.address, city: c.city, cart: c.cart || {},
    orders: (orders || []).map((o: any) => ({ id: o.id, at: o.created_at, status: o.status, total: Number(o.total), delivery: o.delivery, tracking: o.tracking, courier: o.courier, n: (o.items || []).reduce((s: number, i: any) => s + Number(i.qty), 0) })) };
}
let memo: { at: number; body: Record<string, unknown> } | null = null; // the open store's catalogue, kept 10 minutes per instance
const clean = (v: unknown, n: number) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const settings = async () => (await admin.from("shop_settings").select("live, vat, delivery_fee, lead_text, ship, pay_frame").eq("id", 1).single()).data!;

async function staffEmail(req: Request) {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt || jwt.startsWith("sb_")) return null;
  const { data: u } = await admin.auth.getUser(jwt);
  const email = u?.user?.email?.toLowerCase();
  if (!email) return null;
  const { data: s } = await admin.from("crm_staff").select("email").eq("active", true).ilike("email", email).maybeSingle();
  return s ? email : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
  if (req.method !== "POST") return json(req, { ok: false, error: "POST only" }, 405);
  const body = await req.json().catch(() => ({})) as Record<string, any>;
  const action = String(body.action || "");

  if (action === "catalog") {
    const st = await settings();
    // while the store is closed, products are shown only to signed-in staff
    if (!st.live && !(await staffEmail(req))) return json(req, { ok: true, live: false, gated: true, lead_text: st.lead_text, delivery_fee: st.delivery_fee, items: [] });
    if (st.live && memo && Date.now() - memo.at < 600000) return json(req, memo.body, 200, { "cache-control": "public, max-age=300" });
    // the API returns at most 1000 rows per call: read the catalogue page by page
    const rows: Record<string, any>[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin.rpc("shop_catalog").order("id").range(from, from + 999);
      if (error) return json(req, { ok: false, error: "catalog" }, 500);
      rows.push(...((data || []) as Record<string, any>[]));
      if (!data || data.length < 1000) break;
    }
    // shop_hd_images: pictures cut again from the supplier's catalogue at full size (hd/…); the 240 px thumbnail is the fallback
    const { data: hdRows } = await admin.from("shop_hd_images").select("path").limit(10000);
    const hd = new Set((hdRows || []).map((x: any) => x.path as string));
    for (const r of rows) if (r.image_path && hd.has(r.image_path)) r.image_path = hdPath(r.image_path);
    const paths = [...new Set(rows.map((r) => r.image_path).filter(Boolean))] as string[];
    const signed = new Map<string, string>();
    for (let i = 0; i < paths.length; i += 500) {
      const { data: s } = await admin.storage.from("supplier-files").createSignedUrls(paths.slice(i, i + 500), 86400);
      for (const x of s || []) if (x.signedUrl && x.path) signed.set(x.path, x.signedUrl);
    }
    const items = rows.map((r) => ({ id: r.id, code: r.code, name: r.name, size: r.size, unit: r.unit, category: r.category, price: Number(r.price), img: r.image_path ? signed.get(r.image_path) || null : null, big: parcel(String(r.name)) || undefined }));
    const out = { ok: true, live: st.live, lead_text: st.lead_text, ship: st.ship || null, items };
    if (st.live) memo = { at: Date.now(), body: out };
    return json(req, out, 200, st.live ? { "cache-control": "public, max-age=300" } : { "cache-control": "private, no-store" });
  }

  // ---- customer account ----
  if (action === "login_start") {
    // always the same answer, so the page never tells who has an account
    const email = clean(body.email, 120).toLowerCase(), now = new Date();
    if (!EMAIL_RE.test(email)) return json(req, { ok: false, error: "כתובת מייל לא תקינה" }, 400);
    const { count } = await admin.from("shop_login_links").select("id", { count: "exact", head: true }).eq("email", email).gt("created_at", new Date(now.getTime() - 3600e3).toISOString());
    if ((count || 0) < 4) {
      const code = secret();
      await admin.from("shop_login_links").insert({ code_hash: await sha(code), code, email, expires_at: new Date(now.getTime() + 30 * 60e3).toISOString() });
    }
    return json(req, { ok: true });
  }
  if (action === "login_finish") {
    const code = String(body.code || "");
    if (!/^[0-9a-f]{48}$/.test(code)) return json(req, { ok: false, error: "הקישור לא תקין" }, 400);
    const now = new Date().toISOString();
    const { data: l } = await admin.from("shop_login_links").update({ used_at: now, code: null }).eq("code_hash", await sha(code)).is("used_at", null).gt("expires_at", now).select("email").maybeSingle();
    if (!l) return json(req, { ok: false, error: "הקישור כבר נוצל או שפג תוקפו. אפשר לבקש קישור חדש." }, 400);
    let { data: c } = await admin.from("shop_customers").select("*").eq("email", l.email).maybeSingle();
    if (!c) c = (await admin.from("shop_customers").insert({ email: l.email }).select("*").single()).data;
    // orders this address made as a guest join the account now that the address is proven
    await admin.from("shop_orders").update({ customer_id: c!.id }).eq("email", l.email).is("customer_id", null);
    await admin.from("shop_customers").update({ last_seen: now }).eq("id", c!.id);
    await admin.from("shop_sessions").delete().eq("customer_id", c!.id).eq("verified", false);
    return json(req, { ok: true, session: await newSession(c!.id, true), me: await profile(c!) });
  }
  if (action === "me" || action === "cart_save" || action === "logout") {
    const c = await customerOf(body.session);
    if (!c) return json(req, { ok: false, error: "session" }, 401);
    if (action === "logout") { await admin.from("shop_sessions").delete().eq("token_hash", await sha(String(body.session))); return json(req, { ok: true }); }
    if (action === "cart_save") { await admin.from("shop_customers").update({ cart: cleanCart(body.cart), last_seen: new Date().toISOString() }).eq("id", c.id); return json(req, { ok: true }); }
    return json(req, { ok: true, me: await profile(c) });
  }

  if (action === "status") {
    const token = String(body.token || "");
    if (!/^[0-9a-f-]{36}$/i.test(token)) return json(req, { ok: false }, 400);
    const { data: o } = await admin.from("shop_orders").select("id, created_at, status, items, items_total, delivery, delivery_fee, total, charged, test").eq("token", token).maybeSingle();
    if (!o) return json(req, { ok: false }, 404);
    return json(req, { ok: true, order: o });
  }

  if (action === "checkout") {
    const st = await settings();
    const staff = await staffEmail(req);
    if (!st.live && !staff) return json(req, { ok: false, error: "החנות עוד לא פתוחה לציבור" }, 403);
    if (!(Deno.env.get("TRANZILA_APP_KEY") && Deno.env.get("TRANZILA_SECRET"))) return json(req, { ok: false, error: "התשלום עוד לא מוגדר" }, 503);
    // signed-in staff can still make a ₪5 test order after the store opened (shop/?test=1)
    const test = !st.live || (!!staff && body.test === true);
    const name = clean(body.name, 60), email = clean(body.email, 120).toLowerCase(), phone = String(body.phone || "").replace(/\D/g, "");
    const delivery = body.delivery === "delivery" ? "delivery" : "pickup";
    const address = clean(body.address, 120), city = clean(body.city, 60), notes = clean(body.notes, 300);
    if (name.length < 2) return json(req, { ok: false, error: "שם מלא חסר" }, 400);
    if (!/^0(5\d|[2-9])\d{7}$/.test(phone)) return json(req, { ok: false, error: "מספר טלפון לא תקין" }, 400);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(req, { ok: false, error: "כתובת מייל לא תקינה" }, 400);
    if (body.terms !== true) return json(req, { ok: false, error: "יש לאשר את תקנון האתר ותנאי הביטול" }, 400);
    if (delivery === "delivery" && !st.ship) return json(req, { ok: false, error: "כרגע איסוף מאולם התצוגה בלבד" }, 400);
    if (delivery === "delivery" && (address.length < 3 || city.length < 2)) return json(req, { ok: false, error: "כתובת למשלוח חסרה" }, 400);

    const want = new Map<number, number>();
    for (const it of Array.isArray(body.items) ? body.items.slice(0, 60) : []) {
      const id = Math.trunc(Number(it?.id)), qty = Math.min(50, Math.max(0, Math.trunc(Number(it?.qty))));
      if (id > 0 && qty > 0) want.set(id, (want.get(id) || 0) + qty);
    }
    if (!want.size) return json(req, { ok: false, error: "הסל ריק" }, 400);
    const { data: rows } = await admin.rpc("shop_catalog", { p_ids: [...want.keys()] });
    const found = new Map(((rows || []) as Record<string, any>[]).map((r) => [Number(r.id), r]));
    if (found.size !== want.size) return json(req, { ok: false, error: "חלק מהמוצרים בסל כבר לא זמינים. רעננו את הדף." }, 409);
    const items = [...want].map(([id, qty]) => { const r = found.get(id)!; return { id, code: r.code, name: r.name, size: r.size, qty, price: Number(r.price) }; });
    const itemsTotal = items.reduce((s, i) => s + i.price * i.qty, 0);
    const fee = delivery === "delivery" ? Number(shipFee(st.ship, items)) : 0;
    const total = Math.round((itemsTotal + fee) * 100) / 100;
    if (!(total >= 1 && total <= 200000)) return json(req, { ok: false, error: "סכום לא תקין" }, 400);
    const charged = test ? TEST_SUM : total;
    const tail9 = phone.slice(-9);

    // The customer: the signed-in one, or a new account opened for a first-time address (this device is then signed in).
    // An address that already has an account is never signed in from a checkout; its order joins the account at the next sign-in.
    let cust = await customerOf(body.session), session: string | null = null;
    if (!cust && !test) {
      const { data: made } = await admin.from("shop_customers").insert({ email }).select("*").maybeSingle();
      if (made) { cust = made; session = await newSession(made.id); }
    }
    if (cust && !test) await admin.from("shop_customers").update({ name, phone, tail9, ...(delivery === "delivery" ? { address, city } : {}), ...(body.marketing === true ? { marketing_ok: true } : {}), cart: {}, last_seen: new Date().toISOString() }).eq("id", cust.id);
    const { data: pay, error: payErr } = await admin.from("crm_pay_requests").insert({ tail9, amount: charged, description: "הזמנה מהחנות", test, created_by: staff || "shop" }).select("*").single();
    if (payErr) return json(req, { ok: false, error: "שגיאה ביצירת ההזמנה" }, 500);
    const { data: order, error: oErr } = await admin.from("shop_orders").insert({
      name, phone, email, delivery, address: delivery === "delivery" ? address : null, city: delivery === "delivery" ? city : null, notes: notes || null,
      items, items_total: itemsTotal, delivery_fee: fee, total, charged, test, terms_at: new Date().toISOString(), marketing_ok: body.marketing === true,
      pay_request_id: pay!.id, created_by: staff, customer_id: cust?.id ?? null,
    }).select("id, token").single();
    if (oErr) return json(req, { ok: false, error: "שגיאה ביצירת ההזמנה" }, 500);
    const desc = ("הזמנה " + order!.id + " מהחנות").slice(0, 80);
    await admin.from("crm_pay_requests").update({ description: desc }).eq("id", pay!.id);

    // Payment inside our own page (shop_settings.pay_frame, component /pay/pay.js): no Tranzila pay request is made, so the customer
    // gets no link mail. The page pays through the row's public token and crm-pay-notify confirms it (zpay / zk in the notify).
    if ((st.pay_frame || (test && body.test === true)) && body.frame === true && (pay as any).pay_token) {
      await admin.from("crm_audit").insert({ who: staff || "shop", action: "shop_checkout", tail9, detail: { order: order!.id, pay: pay!.id, total, charged, test, lines: items.length, frame: true } });
      return json(req, { ok: true, pay: (pay as any).pay_token, token: order!.token, order: order!.id, test, session });
    }
    // On a test the page charges ₪5 as one line and the copy goes to Aviv; live, the customer gets Tranzila's mail with the real lines.
    const lines = test
      ? [{ name: "בדיקת חנות - הזמנה " + order!.id, unit_price: TEST_SUM, units_number: 1, type: "I", price_type: "G", currency_code: "ILS" }]
      : [...items.map((i) => ({ name: clean((i.code ? i.code + " " : "") + i.name, 70), unit_price: i.price, units_number: i.qty, type: "I", price_type: "G", currency_code: "ILS" })),
         ...(fee > 0 ? [{ name: "משלוח", unit_price: fee, units_number: 1, type: "S", price_type: "G", currency_code: "ILS" }] : [])];
    const pr: Record<string, any> = {
      terminal_name: TERMINAL, created_by_user: "shop", created_by_system: "ziso-shop", created_via: "TRAPI",
      request_date: ilDate(), request_language: "hebrew", response_language: "hebrew", action_type: 1,
      request_currency: "ILS", request_vat: Number(st.vat), payments_number: test ? 1 : (total >= 1000 ? 6 : 1), payment_plans: (!test && total >= 1000) ? [1, 8] : [1], payment_methods: [1, 15],
      client: { name, contact_person: name, email: test ? OWNER : email, phone_number: phone },
      send_email: { sender_name: "זיסו קרמיקה", sender_email: BIZ_EMAIL },
      items: lines,
    };
    const { data: cs } = await admin.from("crm_settings").select("tranzila_auth").eq("id", 1).maybeSingle();
    const scheme = (cs?.tranzila_auth as "A" | "B") || "A";
    let x = await tranzila("/v1/pr/create", pr, scheme);
    if (Number(x.j.error_code) === 20403) { pr.payment_methods = [1]; x = await tranzila("/v1/pr/create", pr, scheme); }
    if (Number(x.j.error_code) !== 0 && pr.payments_number > 1) { pr.payments_number = 1; pr.payment_plans = [1]; x = await tranzila("/v1/pr/create", pr, scheme); }
    if (Number(x.j.error_code) !== 0 || !x.j.pr_link) {
      const err = `http ${x.http} code ${x.j.error_code ?? "?"}: ${String(x.j.message || "").slice(0, 200)}`;
      await admin.from("crm_pay_requests").update({ status: "failed", error: err }).eq("id", pay!.id);
      await admin.from("shop_orders").update({ status: "failed" }).eq("id", order!.id);
      return json(req, { ok: false, error: "דף התשלום לא נפתח. נסו שוב או התקשרו 050-4770040." }, 502);
    }
    await admin.from("crm_pay_requests").update({ pr_id: String(x.j.pr_id ?? ""), pr_link: String(x.j.pr_link) }).eq("id", pay!.id);
    // the taking (and its receipt task) is written by the shop_order_paid trigger when Tranzila confirms the money
    await admin.from("crm_audit").insert({ who: staff || "shop", action: "shop_checkout", tail9, detail: { order: order!.id, pay: pay!.id, total, charged, test, lines: items.length } });
    return json(req, { ok: true, pr_link: x.j.pr_link, token: order!.token, order: order!.id, test, session });
  }
  // ---- admin (crm/shop.html): signed-in staff handle orders; products, prices and settings are the owner's ----
  if (action.startsWith("admin_")) {
    const staff = await staffEmail(req);
    if (!staff) return json(req, { ok: false, error: "צריך להתחבר ל-CRM" }, 401);
    const owner = staff === OWNER, now = new Date().toISOString();
    const audit = (what: string, detail: unknown) => admin.from("crm_audit").insert({ who: staff, action: what, detail });
    if (action === "admin_orders") {
      const { data } = await admin.from("shop_orders").select("id, created_at, name, phone, email, delivery, address, city, notes, items, items_total, delivery_fee, total, charged, test, status, mail_state, tracking, courier, staff_note, sent_at, done_at, po_state, po_note, cancel_mail_state, cancelled_at, cancel_wa_state")
        .neq("status", "failed").order("id", { ascending: false }).limit(200);
      // the supplier orders the CRM made for each web order (crm_po.shop_order_id)
      const ids = (data || []).filter((o: any) => o.po_state).map((o: any) => o.id);
      const { data: pos } = ids.length ? await admin.from("crm_po").select("shop_order_id, po_no, supplier_name, status, summary, receive_state, cancel_ack").in("shop_order_id", ids) : { data: [] };
      return json(req, { ok: true, owner, orders: (data || []).map((o: any) => ({ ...o, pos: (pos || []).filter((p: any) => p.shop_order_id === o.id) })) });
    }
    if (action === "admin_order") {
      const id = Number(body.id), patch: Record<string, unknown> = {};
      const { data: o } = await admin.from("shop_orders").select("id, status, cancel_mail_state, cancel_wa_state").eq("id", id).maybeSingle();
      if (!o) return json(req, { ok: false, error: "ההזמנה לא נמצאה" }, 404);
      if (body.status !== undefined) {
        const to = String(body.status), ok: Record<string, string[]> = { paid: ["sent", "cancelled"], sent: ["done", "paid", "cancelled"], done: ["sent"], cancelled: ["paid"] };
        if (!(ok[o.status] || []).includes(to)) return json(req, { ok: false, error: "אי אפשר לשנות את הסטטוס הזה" }, 409);
        patch.status = to;
        if (to === "sent") patch.sent_at = now;
        if (to === "done") patch.done_at = now;
        // the customer hears about a cancellation by mail, once (a reopened and cancelled again order is not mailed twice)
        if (to === "cancelled") { patch.cancelled_at = now; if (!o.cancel_mail_state) patch.cancel_mail_state = "queued"; if (!o.cancel_wa_state) patch.cancel_wa_state = "queued"; }
      }
      if (body.tracking !== undefined) patch.tracking = clean(body.tracking, 60) || null;
      if (body.courier !== undefined) patch.courier = clean(body.courier, 40) || null;
      if (body.staff_note !== undefined) patch.staff_note = clean(body.staff_note, 500) || null;
      if (!Object.keys(patch).length) return json(req, { ok: false, error: "אין שינוי" }, 400);
      const { error } = await admin.from("shop_orders").update(patch).eq("id", id);
      if (error) return json(req, { ok: false, error: "השמירה נכשלה" }, 500);
      await audit("shop_admin_order", { id, ...patch });
      return json(req, { ok: true });
    }
    if (action === "admin_products") {
      const q = clean(body.q, 60).replace(/[,()*%\\"'.:]/g, " ").trim(), off = Math.max(0, Number(body.offset) || 0);
      let rq = admin.rpc("shop_catalog_full", {}, { count: "exact" });
      if (q) rq = rq.or(`name.ilike.*${q.split(/\s+/).join("*")}*,code.ilike.*${q}*`);
      if (/^[0-9a-f-]{36}$/i.test(String(body.supplier || ""))) rq = rq.eq("supplier_id", body.supplier);
      if (body.only === "hidden") rq = rq.eq("hidden", true);
      if (body.only === "manual") rq = rq.not("ov_price", "is", null);
      const { data, count, error } = await rq.order("name").order("id").range(off, off + 39);
      if (error) return json(req, { ok: false, error: "החיפוש נכשל" }, 500);
      const rows = (data || []) as Record<string, any>[];
      const { data: sg } = rows.length ? await admin.storage.from("supplier-files").createSignedUrls(rows.map((r) => r.image_path), 3600) : { data: [] };
      const img = new Map((sg || []).map((x: any) => [x.path, x.signedUrl]));
      return json(req, { ok: true, owner, total: count ?? rows.length, items: rows.map((r) => ({ key: r.key, code: r.code, name: r.name, size: r.size, supplier: r.supplier_id, price: Number(r.price), cost: owner ? Number(r.cost) : undefined, calc: Number(r.calc), manual: r.ov_price != null, hidden: r.hidden, img: img.get(r.image_path) || null })) });
    }
    if (action === "admin_settings") {
      const { data: st } = await admin.from("shop_settings").select("live, vat, lead_text, ship, multipliers").eq("id", 1).single();
      const ids = Object.keys(st!.multipliers || {});
      const { data: sup } = await admin.from("sp_suppliers").select("id, name").in("id", ids);
      const { data: cnt } = await admin.rpc("shop_supplier_counts");
      const n = new Map<string, number>(((cnt || []) as any[]).map((r) => [r.supplier_id, Number(r.n)]));
      return json(req, { ok: true, owner, live: st!.live, vat: Number(st!.vat), lead_text: st!.lead_text, ship: st!.ship,
        suppliers: (sup || []).map((x: any) => ({ id: x.id, name: x.name, mult: owner ? Number(st!.multipliers[x.id]) : undefined, count: n.get(x.id) || 0 })).sort((a: any, b: any) => b.count - a.count) });
    }
    if (!owner) return json(req, { ok: false, error: "רק אביב יכול לשנות מוצרים, מחירים והגדרות" }, 403);
    // ---- full-size pictures: the owner's browser cuts them from the catalogue files and stores them under hd/ ----
    if (action === "admin_img_plan") {
      const need = new Set<string>();
      for (let from = 0; ; from += 1000) {
        const { data } = await admin.rpc("shop_catalog").select("id,image_path").order("id").range(from, from + 999);
        for (const r of data || []) if (r.image_path) need.add(r.image_path);
        if (!data || data.length < 1000) break;
      }
      const ups = [...new Set([...need].map((x) => x.split("/")[1]))];
      const images: any[] = [];
      for (const id of ups) for (let from = 0; ; from += 1000) {
        const { data } = await admin.from("sp_images").select("path,page,box").eq("upload_id", id).order("id").range(from, from + 999);
        for (const r of data || []) if (need.has(r.path)) images.push({ path: r.path, up: id, page: r.page, box: r.box });
        if (!data || data.length < 1000) break;
      }
      const { data: us } = await admin.from("sp_uploads").select("id,file_name,file_path,archive_paths,size_bytes").in("id", ups);
      const uploads = [];
      for (const u of us || []) {
        const ps: string[] = u.archive_paths?.length ? u.archive_paths : (!String(u.file_path || "").startsWith("wa:") && u.file_path ? [u.file_path] : []);
        const { data: sg } = ps.length ? await admin.storage.from("supplier-files").createSignedUrls(ps, 14400) : { data: [] };
        uploads.push({ id: u.id, name: u.file_name, bytes: u.size_bytes, parts: (sg || []).map((x: any) => x.signedUrl) });
      }
      const { data: have } = await admin.from("shop_hd_images").select("path").limit(10000);
      return json(req, { ok: true, uploads, images, have: (have || []).map((x: any) => x.path), need: need.size });
    }
    if (action === "admin_img_up") {
      const list = (Array.isArray(body.paths) ? body.paths : []).slice(0, 60).filter((x: unknown) => typeof x === "string" && /^img\/[0-9a-f-]{36}\/[\w.-]+\.jpg$/.test(x as string));
      const out = [];
      for (const x of list) {
        const { data } = await admin.storage.from("supplier-files").createSignedUploadUrl(hdPath(x), { upsert: true });
        out.push({ path: x, url: data?.signedUrl || null });
      }
      return json(req, { ok: true, urls: out });
    }
    if (action === "admin_img_done") {
      const rows = (Array.isArray(body.rows) ? body.rows : []).slice(0, 200).filter((x: any) => x && typeof x.path === "string" && x.path.startsWith("img/"))
        .map((x: any) => ({ path: x.path, w: Number(x.w) || 0, h: Number(x.h) || 0, src_w: Number(x.sw) || 0, src_h: Number(x.sh) || 0, updated_at: now }));
      if (rows.length) { const { error } = await admin.from("shop_hd_images").upsert(rows, { onConflict: "path" }); if (error) return json(req, { ok: false, error: "db" }, 500); }
      memo = null;
      return json(req, { ok: true, n: rows.length });
    }
    if (action === "admin_item") {
      const key = String(body.key || "").slice(0, 400);
      const { data: rows } = await admin.rpc("shop_catalog_full").eq("key", key).limit(1);
      const r = (rows || [])[0] as Record<string, any> | undefined;
      if (!r) return json(req, { ok: false, error: "המוצר לא נמצא" }, 404);
      const hidden = body.hidden === undefined ? !!r.hidden : body.hidden === true;
      let price: number | null = body.price === undefined ? (r.ov_price == null ? null : Number(r.ov_price)) : (body.price === null || body.price === "" ? null : Math.ceil(Number(body.price)));
      if (price !== null && !(price > 0 && price <= 200000)) return json(req, { ok: false, error: "מחיר לא תקין" }, 400);
      // never below what the product costs us (incl. VAT)
      if (price !== null && price < Number(r.cost)) return json(req, { ok: false, error: "המחיר נמוך מהעלות שלנו (" + Math.ceil(Number(r.cost)) + " ₪ כולל מע\"מ)" }, 400);
      const { error } = !hidden && price === null ? await admin.from("shop_item_overrides").delete().eq("key", key)
        : await admin.from("shop_item_overrides").upsert({ key, hidden, price, updated_at: now, updated_by: staff });
      if (error) return json(req, { ok: false, error: "השמירה נכשלה" }, 500);
      memo = null;
      await audit("shop_admin_item", { key, hidden, price });
      return json(req, { ok: true, hidden, price: price ?? Number(r.calc), manual: price !== null });
    }
    if (action === "admin_settings_set") {
      const { data: st } = await admin.from("shop_settings").select("ship, multipliers").eq("id", 1).single();
      const patch: Record<string, unknown> = { updated_at: now };
      if (body.lead_text !== undefined) { const t = clean(body.lead_text, 60); if (!t) return json(req, { ok: false, error: "חסר זמן אספקה" }, 400); patch.lead_text = t; }
      if (body.ship && typeof body.ship === "object") {
        const ship: Record<string, number> = {};
        for (const k of ["small", "sink", "extra_sink", "heavy"]) { const v = Number(body.ship[k]); if (!(v >= 0 && v <= 2000)) return json(req, { ok: false, error: "מחיר משלוח לא תקין" }, 400); ship[k] = Math.round(v); }
        patch.ship = ship;
      }
      if (body.multipliers && typeof body.multipliers === "object") {
        const m: Record<string, number> = { ...(st!.multipliers || {}) };
        for (const [id, v] of Object.entries(body.multipliers)) {
          if (!(id in m)) return json(req, { ok: false, error: "ספק לא מוכר" }, 400);   // adding or removing a supplier is not done from here
          const x = Number(v); if (!(x >= 1.2 && x <= 5)) return json(req, { ok: false, error: "מכפיל בין 1.2 ל-5" }, 400);
          m[id] = Math.round(x * 100) / 100;
        }
        patch.multipliers = m;
      }
      const { error } = await admin.from("shop_settings").update(patch).eq("id", 1);
      if (error) return json(req, { ok: false, error: "השמירה נכשלה" }, 500);
      memo = null;
      await audit("shop_admin_settings", patch);
      return json(req, { ok: true });
    }
  }
  return json(req, { ok: false, error: "action" }, 400);
});
