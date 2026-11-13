// crm-refund: card refunds from the till page (kupa.html), 13.11.2026.
// POST with the signed-in staff user's Supabase JWT:
//   { action: "status" }                               -> { on, ready, owner }
//   { action: "list", day: "YYYY-MM-DD" }               -> today's (or that day's) card charges from Tranzila's own list
//   { action: "refund", day, index, amount, reason }    -> refunds part or all of ONE existing charge
//   { action: "secret", tranzila_pw, credit_pass }      -> Aviv only: saves the two terminal passwords a refund needs
// Rules: a refund exists only against a charge that Tranzila itself lists (never trusted from the page), up to what is
// left of it after earlier refunds, with a reason; one open refund per charge at a time; every refund is written to
// crm_refunds before Tranzila is called, so a lost answer is never lost money: it becomes "unknown" and a task.
// Off for staff until crm_settings.refunds_on = true; while off only Aviv can refund (the real ₪1 test).
// Card data: the card token and expiry are read from Tranzila's list and passed straight back to Tranzila for the
// refund; they are never stored, logged or sent to the page.
import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { autoRefreshToken: false, persistSession: false } });
const TERMINAL = "avivziso", OWNER = "avivziso70@gmail.com";
const ORIGINS = ["https://www.zisoceramics.com", "https://zisoceramics.com", "http://localhost:8000"];
const REFUND_URL = "https://secure5.tranzila.com/cgi-bin/tranzila71u.cgi";
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
async function listPage(day: string, page: number) {
  const app = Deno.env.get("TRANZILA_APP_KEY")!, secret = Deno.env.get("TRANZILA_SECRET")!;
  const time = String(Math.floor(Date.now() / 1000)), nonce = hex(crypto.getRandomValues(new Uint8Array(40)));
  const r = await fetch("https://api.tranzila.com/v1/transactions", {
    method: "POST",
    headers: { "X-tranzila-api-app-key": app, "X-tranzila-api-request-time": time, "X-tranzila-api-nonce": nonce, "X-tranzila-api-access-token": await hmac(secret + time + nonce, app), "content-type": "application/json" },
    body: JSON.stringify({ terminal_name: TERMINAL, transaction_start_date: day, transaction_end_date: day, page }),
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null) as Record<string, unknown> | null;
  return j && Array.isArray(j.transactions) ? { rows: j.transactions as Record<string, unknown>[], total: Number(j.total) || 0 } : null;
}
type Tx = Record<string, unknown>;
async function dayList(day: string): Promise<Tx[] | null> {
  const all: Tx[] = [];
  for (let p = 1; p <= 10; p++) {
    const l = await listPage(day, p);
    if (!l) return p === 1 ? null : all;
    if (!l.rows.length) break;
    all.push(...l.rows);
    if (all.length >= l.total) break; // the answer says how many the day has (seen live: "total":"9")
  }
  return all;
}
// A charge we can refund: a debit that went through. Amount in Tranzila's list is in agorot ("55000" = ₪550).
const isCharge = (t: Tx) => String(t.processor_response_code ?? "") === "000" && String(t.txn_type ?? "").toUpperCase() === "DEBIT" && Number(t.amount) > 0;
const shekels = (t: Tx) => Math.round(Number(t.amount)) / 100;
const ilDay = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
const r2 = (n: number) => Math.round(n * 100) / 100;

async function refundedSoFar(index: string) {
  const { data } = await admin.from("crm_refunds").select("amount, status").eq("tz_index", index).in("status", ["pending", "done", "unknown"]);
  return { sum: r2((data || []).reduce((s, x) => s + Number(x.amount), 0)), open: (data || []).some((x) => x.status !== "done") };
}
async function secrets() {
  const { data } = await admin.from("crm_secrets").select("k, v").in("k", ["tranzila_pw", "tranzila_credit_pass"]);
  const m: Record<string, string> = {}; for (const x of data || []) m[x.k] = x.v;
  return m;
}
// Who paid: our own payment links (same day, same amount, paid) carry the customer's name and phone.
async function crmMatches(day: string) {
  const from = new Date(day + "T00:00:00+02:00"), to = new Date(from.getTime() + 864e5 + 3 * 3600e3);
  const { data: prs } = await admin.from("crm_pay_requests").select("pr_id, tail9, paid_sum, amount, paid_at").eq("status", "paid").gte("paid_at", from.toISOString()).lt("paid_at", to.toISOString());
  const ids = (prs || []).map((p) => p.pr_id).filter(Boolean);
  const { data: tks } = ids.length ? await admin.from("crm_takings").select("pay_pr_id, payer_name, tail9").in("pay_pr_id", ids) : { data: [] as { pay_pr_id: string; payer_name: string; tail9: string }[] };
  return (prs || []).map((p) => {
    const t = (tks || []).find((x) => x.pay_pr_id === p.pr_id);
    return { amount: Number(p.paid_sum ?? p.amount), at: p.paid_at as string, name: t?.payer_name || null, tail9: t?.tail9 || p.tail9 || null };
  });
}
function nameFor(t: Tx, day: string, m: { amount: number; at: string; name: string | null; tail9: string | null }[]) {
  const time = String(t.transaction_time || "");
  const at = time ? new Date(day + "T" + time + "+02:00").getTime() : NaN;
  const hit = m.find((x) => Math.abs(x.amount - shekels(t)) < 0.005 && (!Number.isFinite(at) || Math.abs(new Date(x.at).getTime() - at) < 20 * 60e3 || Math.abs(new Date(x.at).getTime() - at - 3600e3) < 20 * 60e3));
  return hit || null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
  if (req.method !== "POST") return json(req, { ok: false, error: "POST only" }, 405);
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u } = await admin.auth.getUser(jwt);
  const email = u?.user?.email?.toLowerCase();
  if (!email) return json(req, { ok: false, error: "לא מחובר" }, 401);
  const { data: staff } = await admin.from("crm_staff").select("email, name").eq("active", true).ilike("email", email).maybeSingle();
  if (!staff) return json(req, { ok: false, error: "לא מורשה" }, 403);
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const action = String(body.action || "");
  const owner = email === OWNER;

  const { data: st } = await admin.from("crm_settings").select("refunds_on").eq("id", 1).maybeSingle();
  const sec = await secrets();
  const ready = !!(sec.tranzila_pw && sec.tranzila_credit_pass);
  const on = !!st?.refunds_on;

  if (action === "status") return json(req, { ok: true, on, ready, owner });

  if (action === "secret") {
    if (!owner) return json(req, { ok: false, error: "רק אביב" }, 403);
    const pw = String(body.tranzila_pw || "").trim(), cp = String(body.credit_pass || "").trim();
    if (!pw || !cp || pw.length > 64 || cp.length > 64) return json(req, { ok: false, error: "צריך את שתי הסיסמאות" }, 400);
    const now = new Date().toISOString();
    await admin.from("crm_secrets").upsert([{ k: "tranzila_pw", v: pw, updated_by: email, updated_at: now }, { k: "tranzila_credit_pass", v: cp, updated_by: email, updated_at: now }]);
    await admin.from("crm_audit").insert({ who: email, action: "refund_secret_set", detail: {} });
    return json(req, { ok: true, ready: true });
  }

  const day = String(body.day || ilDay());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json(req, { ok: false, error: "תאריך לא תקין" }, 400);
  const ageDays = (Date.now() - new Date(day + "T12:00:00+02:00").getTime()) / 864e5;
  if (ageDays < -1 || ageDays > 60) return json(req, { ok: false, error: "אפשר להחזיר רק על עסקה מ-60 הימים האחרונים" }, 400);

  if (action === "list") {
    const l = await dayList(day);
    if (!l) return json(req, { ok: false, error: "טרנזילה לא ענתה. לנסות שוב בעוד דקה" }, 502);
    const m = await crmMatches(day);
    const { data: refs } = await admin.from("crm_refunds").select("tz_index, amount, status").eq("tz_day", day).in("status", ["pending", "done", "unknown"]);
    const rows = l.filter(isCharge).map((t) => {
      const idx = String(t.index), who = nameFor(t, day, m);
      const done = (refs || []).filter((x) => x.tz_index === idx);
      const refunded = r2(done.reduce((s, x) => s + Number(x.amount), 0));
      return { index: idx, time: String(t.transaction_time || "").slice(0, 5), amount: shekels(t), payments: Number(t.number_of_payments) || 0,
        brand: String(t.card_brand || t.card_description || ""), name: who?.name || null, refunded, open: done.some((x) => x.status !== "done") };
    }).sort((a, b) => b.time.localeCompare(a.time));
    return json(req, { ok: true, day, on, ready, rows });
  }

  if (action === "refund") {
    // while off, only Aviv can refund (the first real ₪1 test); everyone else waits for the switch
    if (!on && !owner) return json(req, { ok: false, error: "החזרים עוד לא הופעלו. אביב צריך לאשר" }, 403);
    if (!ready) return json(req, { ok: false, error: "חסרות סיסמאות המסוף לזיכוי. אביב צריך להזין אותן פעם אחת" }, 503);
    const index = String(body.index || "").trim(), amount = r2(Number(body.amount)), reason = String(body.reason || "").trim().slice(0, 300);
    if (!/^\d{1,12}$/.test(index)) return json(req, { ok: false, error: "עסקה לא תקינה" }, 400);
    if (!(amount >= 1)) return json(req, { ok: false, error: "סכום לא תקין" }, 400);
    if (reason.length < 3) return json(req, { ok: false, error: "צריך לכתוב למה מחזירים" }, 400);
    // the charge itself comes from Tranzila's list, never from the page
    const l = await dayList(day);
    if (!l) return json(req, { ok: false, error: "טרנזילה לא ענתה. לא בוצע זיכוי. לנסות שוב בעוד דקה" }, 502);
    const t = l.find((x) => String(x.index) === index);
    if (!t || !isCharge(t)) return json(req, { ok: false, error: "העסקה לא נמצאה אצל טרנזילה ביום הזה" }, 404);
    const orig = shekels(t), so = await refundedSoFar(index);
    if (so.open) return json(req, { ok: false, error: "יש כבר זיכוי פתוח על העסקה הזו. לבדוק אותו קודם" }, 409);
    const left = r2(orig - so.sum);
    if (amount > left + 0.001) return json(req, { ok: false, error: left > 0 ? "אפשר להחזיר עד " + left.toLocaleString("he-IL") + " ₪ על העסקה הזו" : "העסקה הזו כבר הוחזרה במלואה" }, 400);
    const token = String(t.credit_card_token || ""), mm = String(t.expiration_month || "").padStart(2, "0"), yy = String(t.expiration_year || "").slice(-2);
    if (!token || !/^\d{2}$/.test(mm) || !/^\d{2}$/.test(yy)) return json(req, { ok: false, error: "חסרים פרטי כרטיס בעסקה אצל טרנזילה. לזכות דרך המסוף" }, 422);
    const who = nameFor(t, day, await crmMatches(day));
    // write first: if the answer is lost, the row stays and becomes "unknown" (never a silent second refund)
    const ins = await admin.from("crm_refunds").insert({ "by": email, tz_index: index, tz_day: day, orig_amount: orig, amount, reason, payer_name: who?.name || null, tail9: who?.tail9 || null }).select("id").single();
    if (ins.error || !ins.data) return json(req, { ok: false, error: "יש כבר זיכוי פתוח על העסקה הזו" }, 409);
    const id = ins.data.id;
    const form = new URLSearchParams({ supplier: TERMINAL, TranzilaPW: sec.tranzila_pw, CreditPass: sec.tranzila_credit_pass, tranmode: "C" + index,
      authnr: String(t.authorization_number || ""), sum: amount.toFixed(2), currency: "1", cred_type: "1", TranzilaTK: token, expdate: mm + yy });
    let text = "";
    try {
      const r = await fetch(REFUND_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString(), signal: AbortSignal.timeout(25000) });
      text = await r.text();
    } catch (_) {
      await admin.from("crm_refunds").update({ status: "unknown", error: "no answer from Tranzila" }).eq("id", id);
      await admin.from("crm_audit").insert({ who: email, action: "refund_unknown", tail9: who?.tail9 || null, detail: { id, index, amount } });
      return json(req, { ok: false, unknown: true, error: "לא התקבלה תשובה מטרנזילה. לא לנסות שוב: לבדוק במסוף אם הזיכוי עבר. נפתחה משימה" }, 504);
    }
    // the answer is a query string; only these fields are kept (it also echoes the token, which is dropped)
    const a = new URLSearchParams(text.trim().replace(/^[^A-Za-z]*/, ""));
    const code = (a.get("Response") || "").trim();
    if (code === "000") {
      await admin.from("crm_refunds").update({ status: "done", response_code: code, refund_index: a.get("index"), refund_auth: a.get("ConfirmationCode") }).eq("id", id);
      await admin.from("crm_audit").insert({ who: email, action: "refund_done", tail9: who?.tail9 || null, detail: { id, index, amount } });
      return json(req, { ok: true, id, amount, left: r2(left - amount), name: who?.name || null });
    }
    const err = code ? "Tranzila code " + code : "unreadable answer";
    await admin.from("crm_refunds").update({ status: code ? "failed" : "unknown", response_code: code || null, error: err }).eq("id", id);
    await admin.from("crm_audit").insert({ who: email, action: code ? "refund_failed" : "refund_unknown", tail9: who?.tail9 || null, detail: { id, index, amount, code } });
    return json(req, { ok: false, unknown: !code, code, error: code ? "טרנזילה סירבה לזיכוי (קוד " + code + "). הכסף לא הוחזר" : "התשובה מטרנזילה לא ברורה. לא לנסות שוב: לבדוק במסוף. נפתחה משימה" }, 502);
  }
  return json(req, { ok: false, error: "action לא מוכר" }, 400);
});
