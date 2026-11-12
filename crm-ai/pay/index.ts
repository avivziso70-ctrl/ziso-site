// crm-pay: Tranzila payment-request links for zisoceramics.com/crm.
// POST with the signed-in staff user's Supabase JWT:
//   { action: "status" }                     -> { configured, auth }
//   { action: "check" }   (Aviv only)        -> read-only auth test on /v1/transactions, remembers scheme A/B
//   { action: "create", tail9, amount, description?, payments?, test? } -> { pr_link, pr_id, payments }
// Keys come only from TRANZILA_APP_KEY / TRANZILA_SECRET (edge secrets). Nothing customer-related is logged.
// A payment request only creates a link; nobody is charged until the customer pays. Tranzila's copy email goes to
// our own mailbox; the link comes back to the CRM and staff send it on WhatsApp. test=true: ₪5 (issuers decline ₪1) to Aviv's own email, Aviv only.
// payments (1-12, default 1): instalments on the link. If Tranzila refuses the instalment request the link is
// created for a single payment and the answer says so (payments: 1, payments_asked: n), so the page can warn.
import { createClient } from "npm:@supabase/supabase-js@2";

const url = Deno.env.get("SUPABASE_URL")!, service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(url, service, { auth: { autoRefreshToken: false, persistSession: false } });
const TERMINAL = "avivziso", OWNER = "avivziso70@gmail.com", BIZ_EMAIL = "info@zisoceramics.com";
const ORIGINS = ["https://www.zisoceramics.com", "https://zisoceramics.com", "http://localhost:8000"];
function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return { "access-control-allow-origin": ORIGINS.includes(o) ? o : ORIGINS[0], "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "POST, OPTIONS", vary: "origin", "content-type": "application/json" };
}
const json = (req: Request, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors(req) });

const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b as ArrayBuffer)).map((x) => x.toString(16).padStart(2, "0")).join("");
async function hmac(key: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
}
// Tranzila docs disagree on the signature; A = authentication pages, B = quickstart.
async function headers(scheme: "A" | "B") {
  const app = Deno.env.get("TRANZILA_APP_KEY")!, secret = Deno.env.get("TRANZILA_SECRET")!;
  const time = String(scheme === "A" ? Math.floor(Date.now() / 1000) : Date.now());
  const nonce = hex(crypto.getRandomValues(new Uint8Array(scheme === "A" ? 40 : 20)));
  const token = scheme === "A" ? await hmac(secret + time + nonce, app) : await hmac(secret, app + time + nonce);
  return { "X-tranzila-api-app-key": app, "X-tranzila-api-request-time": time, "X-tranzila-api-nonce": nonce, "X-tranzila-api-access-token": token, "content-type": "application/json" };
}
async function call(path: string, body: unknown, scheme: "A" | "B") {
  const r = await fetch("https://api.tranzila.com" + path, { method: "POST", headers: await headers(scheme), body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { http: r.status, j: j as Record<string, any> };
}
const authFailed = (x: { http: number; j: Record<string, any> }) => x.http === 401 || x.http === 403 || Number(x.j.error_code) === 20002;
async function getScheme(): Promise<"A" | "B" | null> {
  const { data } = await admin.from("crm_settings").select("tranzila_auth").eq("id", 1).maybeSingle();
  return (data?.tranzila_auth as "A" | "B") || null;
}
const ilDate = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
  if (req.method !== "POST") return json(req, { ok: false, error: "POST only" }, 405);
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u } = await admin.auth.getUser(jwt);
  const email = u?.user?.email?.toLowerCase();
  if (!email) return json(req, { ok: false, error: "לא מחובר" }, 401);
  const { data: staff } = await admin.from("crm_staff").select("email").eq("active", true).ilike("email", email).maybeSingle();
  if (!staff) return json(req, { ok: false, error: "לא מורשה" }, 403);
  const body = await req.json().catch(() => ({}));
  const configured = !!(Deno.env.get("TRANZILA_APP_KEY") && Deno.env.get("TRANZILA_SECRET"));
  const action = String(body.action || "");

  if (action === "status") return json(req, { ok: true, configured, auth: await getScheme() });
  if (!configured) return json(req, { ok: false, error: "מפתחות טרנזילה עוד לא הוגדרו" }, 503);

  if (action === "check") {
    if (email !== OWNER) return json(req, { ok: false, error: "רק אביב" }, 403);
    const d = ilDate(), q = { terminal_name: TERMINAL, transaction_start_date: d, transaction_end_date: d, page: 1 };
    const out: Record<string, unknown> = {};
    for (const s of ["A", "B"] as const) {
      const x = await call("/v1/transactions", q, s);
      out[s] = { http: x.http, error_code: x.j.error_code ?? null, message: x.j.message ?? null };
      if (!authFailed(x) && x.http < 300) {
        await admin.from("crm_settings").update({ tranzila_auth: s, updated_by: email, updated_at: new Date().toISOString() }).eq("id", 1);
        return json(req, { ok: true, scheme: s, results: out });
      }
    }
    return json(req, { ok: false, error: "האימות מול טרנזילה נכשל", results: out }, 502);
  }

  if (action === "create") {
    const tail9 = String(body.tail9 || "").replace(/\D/g, "");
    if (tail9.length !== 9) return json(req, { ok: false, error: "tail9 חסר" }, 400);
    const test = body.test === true;
    if (test && email !== OWNER) return json(req, { ok: false, error: "בדיקה רק לאביב" }, 403);
    const amount = test ? 5 : Math.round(Number(body.amount) * 100) / 100;
    if (!(amount >= 1 && amount <= 200000)) return json(req, { ok: false, error: "סכום לא תקין" }, 400);
    const asked = test ? 1 : Math.min(12, Math.max(1, Math.round(Number(body.payments) || 1)));
    const desc = String(body.description || "תשלום לזיסו קרמיקה").slice(0, 80);
    const [c1, c2] = await Promise.all([
      admin.from("crm_customers").select("name").eq("tail9", tail9).is("deleted_at", null).maybeSingle(),
      admin.from("priority_customers").select("name").eq("tail9", tail9).limit(1).maybeSingle(),
    ]);
    const name = test ? "בדיקה - אביב" : String(c1.data?.name || c2.data?.name || "לקוח זיסו").slice(0, 60);
    const pr = {
      terminal_name: TERMINAL, created_by_user: email.split("@")[0].slice(0, 30), created_by_system: "ziso-crm", created_via: "TRAPI",
      request_date: ilDate(), request_language: "hebrew", response_language: "hebrew", action_type: 1,
      // payment_plans: 1 = regular, 8 = instalments; payments_number = the most payments the customer may choose
      request_currency: "ILS", request_vat: 18, payments_number: asked, payment_plans: asked > 1 ? [1, 8] : [1], payment_methods: [1, 15], // card + Apple Pay; falls back to card only if Apple Pay isn't enabled (20403)
      // Tranzila requires a send channel (error 20404 without one). The email goes to our own mailbox (or Aviv's
      // on a test), never to the customer: staff send the link on WhatsApp.
      client: { name, contact_person: name, email: test ? OWNER : BIZ_EMAIL },
      send_email: { sender_name: "זיסו קרמיקה", sender_email: BIZ_EMAIL },
      items: [{ name: desc, unit_price: amount, units_number: 1, type: "I", price_type: "G", currency_code: "ILS" }],
    };
    const { data: row } = await admin.from("crm_pay_requests").insert({ tail9, amount, description: desc, test, created_by: email }).select("id").single();
    let scheme = await getScheme(), x = await call("/v1/pr/create", pr, scheme || "A");
    if (!scheme && authFailed(x)) { scheme = "B"; x = await call("/v1/pr/create", pr, "B"); } else if (!scheme) scheme = "A";
    if (Number(x.j.error_code) === 20403) { pr.payment_methods = [1]; x = await call("/v1/pr/create", pr, scheme!); }
    const failed = () => Number(x.j.error_code) !== 0 || !x.j.pr_link;
    const errText = () => `http ${x.http} code ${x.j.error_code ?? "?"}: ${String(x.j.message || "").slice(0, 200)}`;
    let payments = asked, instErr: string | null = null;
    if (failed() && asked > 1 && !authFailed(x)) {
      // Tranzila refused the instalment request: keep the reason for the audit row and make a single-payment link instead
      instErr = errText(); payments = 1; pr.payments_number = 1; pr.payment_plans = [1]; pr.payment_methods = [1, 15];
      x = await call("/v1/pr/create", pr, scheme!);
      if (Number(x.j.error_code) === 20403) { pr.payment_methods = [1]; x = await call("/v1/pr/create", pr, scheme!); }
    }
    if (failed()) {
      const err = errText();
      await admin.from("crm_pay_requests").update({ status: "failed", error: err }).eq("id", row!.id);
      return json(req, { ok: false, error: "טרנזילה לא יצרו לינק (" + err + ")" }, 502);
    }
    await admin.from("crm_settings").update({ tranzila_auth: scheme }).eq("id", 1).is("tranzila_auth", null);
    await admin.from("crm_pay_requests").update({ pr_id: String(x.j.pr_id ?? ""), pr_link: String(x.j.pr_link) }).eq("id", row!.id);
    await admin.from("crm_audit").insert({ who: email, action: "pay_request", tail9, detail: { id: row!.id, amount, test, methods: pr.payment_methods, payments, payments_asked: asked, instalments_error: instErr } });
    return json(req, { ok: true, pr_link: x.j.pr_link, pr_id: x.j.pr_id, amount, payments, payments_asked: asked });
  }
  return json(req, { ok: false, error: "action לא מוכר" }, 400);
});
