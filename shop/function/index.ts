// shop: the online store on zisoceramics.com/shop/ (hidden preview until Aviv says go live).
//   { action: "catalog" }                         -> public product list with VAT-inclusive prices (cost never leaves the database)
//   { action: "checkout", items:[{id,qty}], name, phone, email, delivery, address?, city?, notes?, terms:true, marketing? }
//                                                 -> { pr_link, token }  (Tranzila hosted payment page; we never see card data)
//   { action: "status", token }                   -> the order's state, for the customer's own status page
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
const clean = (v: unknown, n: number) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const settings = async () => (await admin.from("shop_settings").select("live, vat, delivery_fee, lead_text").eq("id", 1).single()).data!;

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
    const { data, error } = await admin.rpc("shop_catalog");
    if (error) return json(req, { ok: false, error: "catalog" }, 500);
    const rows = (data || []) as Record<string, any>[];
    const paths = [...new Set(rows.map((r) => r.image_path).filter(Boolean))] as string[];
    const signed = new Map<string, string>();
    for (let i = 0; i < paths.length; i += 500) {
      const { data: s } = await admin.storage.from("supplier-files").createSignedUrls(paths.slice(i, i + 500), 86400);
      for (const x of s || []) if (x.signedUrl && x.path) signed.set(x.path, x.signedUrl);
    }
    const items = rows.map((r) => ({ id: r.id, code: r.code, name: r.name, size: r.size, unit: r.unit, category: r.category, price: Number(r.price), img: r.image_path ? signed.get(r.image_path) || null : null }));
    return json(req, { ok: true, live: st.live, lead_text: st.lead_text, delivery_fee: st.delivery_fee, items }, 200, st.live ? { "cache-control": "public, max-age=600" } : { "cache-control": "private, no-store" });
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
    const test = !st.live;
    const name = clean(body.name, 60), email = clean(body.email, 120).toLowerCase(), phone = String(body.phone || "").replace(/\D/g, "");
    const delivery = body.delivery === "delivery" ? "delivery" : "pickup";
    const address = clean(body.address, 120), city = clean(body.city, 60), notes = clean(body.notes, 300);
    if (name.length < 2) return json(req, { ok: false, error: "שם מלא חסר" }, 400);
    if (!/^0(5\d|[2-9])\d{7}$/.test(phone)) return json(req, { ok: false, error: "מספר טלפון לא תקין" }, 400);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(req, { ok: false, error: "כתובת מייל לא תקינה" }, 400);
    if (body.terms !== true) return json(req, { ok: false, error: "יש לאשר את תקנון האתר ותנאי הביטול" }, 400);
    if (delivery === "delivery" && (st.delivery_fee === null || st.delivery_fee === undefined)) return json(req, { ok: false, error: "כרגע איסוף מאולם התצוגה בלבד" }, 400);
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
    const fee = delivery === "delivery" ? Number(st.delivery_fee) : 0;
    const total = Math.round((itemsTotal + fee) * 100) / 100;
    if (!(total >= 1 && total <= 200000)) return json(req, { ok: false, error: "סכום לא תקין" }, 400);
    const charged = test ? TEST_SUM : total;
    const tail9 = phone.slice(-9);

    const { data: pay, error: payErr } = await admin.from("crm_pay_requests").insert({ tail9, amount: charged, description: "הזמנה מהחנות", test, created_by: staff || "shop" }).select("id").single();
    if (payErr) return json(req, { ok: false, error: "שגיאה ביצירת ההזמנה" }, 500);
    const { data: order, error: oErr } = await admin.from("shop_orders").insert({
      name, phone, email, delivery, address: delivery === "delivery" ? address : null, city: delivery === "delivery" ? city : null, notes: notes || null,
      items, items_total: itemsTotal, delivery_fee: fee, total, charged, test, terms_at: new Date().toISOString(), marketing_ok: body.marketing === true,
      pay_request_id: pay!.id, created_by: staff,
    }).select("id, token").single();
    if (oErr) return json(req, { ok: false, error: "שגיאה ביצירת ההזמנה" }, 500);
    const desc = ("הזמנה " + order!.id + " מהחנות").slice(0, 80);
    await admin.from("crm_pay_requests").update({ description: desc }).eq("id", pay!.id);

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
    if (!test) {
      // the office gets the usual receipt task once Tranzila confirms the money (crm_takings_task / crm_pay_paid)
      await admin.from("crm_takings").insert({ by: "חנות אונליין", amount: total, method: "card_link", payer_name: name, tail9, reason: desc, goods_taken: false,
        goods: items.map((i) => `${i.qty}× ${i.code || ""} ${i.name}`).join("; ").slice(0, 900), pay_pr_id: String(x.j.pr_id ?? ""), payments: 1 });
    }
    await admin.from("crm_audit").insert({ who: staff || "shop", action: "shop_checkout", tail9, detail: { order: order!.id, pay: pay!.id, total, charged, test, lines: items.length } });
    return json(req, { ok: true, pr_link: x.j.pr_link, token: order!.token, order: order!.id, test });
  }
  return json(req, { ok: false, error: "action" }, 400);
});
