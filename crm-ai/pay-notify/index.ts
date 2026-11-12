// crm-pay-notify: Tranzila terminal "notify" URL. Public (verify_jwt false); the notify is unsigned, so nothing is
// trusted until the same payment is found through Tranzila's own /v1/transactions API.
// Accepts GET or POST. The notify setting covers the whole terminal: payments without a pr_id of ours are ignored, and every request gets 200 "OK".
// Only pr_id, sum, Response and ConfirmationCode are read. TranzilaTK (card token) and the raw body are never stored or logged.
//
// 12.11.2026: a real payment (₪550) stayed "waiting" with no alert. Cause: /v1/transactions writes "amount" in AGOROT
// ("55000"), and the old check looked for 550 anywhere in the record. ₪1 test payments passed only because some other
// field happened to be "1". Now the record is matched on its own fields: authorization_number = the notify's
// ConfirmationCode and amount = sum × 100. Also:
//   - the confirmation code is compared a little wider (leading zeros, letter case) and every page of the day is read;
//   - the look is repeated after 3 seconds;
//   - a notify that still can't be confirmed is never silent: the office gets a task in the CRM alerts, the code is kept
//     in the audit row, and the cron job crm-pay-recheck asks again every minute for 24 hours ({ action: "recheck" });
//   - the audit row keeps field NAMES of Tranzila's answer (never values), so the reason can be read afterwards.
// Service calls (recheck, shape) need the x-hook-token header that only the database knows (crm_push_keys).
import { createClient } from "npm:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { autoRefreshToken: false, persistSession: false } });
const TERMINAL = "avivziso";
const ok = () => new Response("OK", { status: 200, headers: { "content-type": "text/plain" } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const hex = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b as ArrayBuffer)).map((x) => x.toString(16).padStart(2, "0")).join("");
async function hmac(key: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
}
async function transactions(day: string, page = 1) {
  const app = Deno.env.get("TRANZILA_APP_KEY")!, secret = Deno.env.get("TRANZILA_SECRET")!;
  const time = String(Math.floor(Date.now() / 1000)), nonce = hex(crypto.getRandomValues(new Uint8Array(40)));
  const r = await fetch("https://api.tranzila.com/v1/transactions", {
    method: "POST",
    headers: { "X-tranzila-api-app-key": app, "X-tranzila-api-request-time": time, "X-tranzila-api-nonce": nonce, "X-tranzila-api-access-token": await hmac(secret + time + nonce, app), "content-type": "application/json" },
    body: JSON.stringify({ terminal_name: TERMINAL, transaction_start_date: day, transaction_end_date: day, page }),
  });
  return r.ok ? await r.json().catch(() => null) : null;
}
const day = (offset: number) => new Date(Date.now() - offset * 864e5).toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });

// Same code? Exact, or the same digits with different leading zeros ("0123456" in the notify, 123456 in the list).
// At least 3 real digits, so a short code can never match a counter field like "1".
function sameCode(v: string, code: string) {
  const a = v.trim().toLowerCase(), b = code.toLowerCase();
  if (a === b) return true;
  if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return false;
  const x = a.replace(/^0+/, ""), y = b.replace(/^0+/, "");
  return x.length >= 3 && x === y;
}
type Diag = { pages: number; records: number; sum_hits: number; code_hits: number; keys: string[] };
// One record of the list (layout seen live 12.11.2026): { index, transaction_time, amount: "55000" (agorot),
// authorization_number, processor_response_code: "000", txn_type: "DEBIT", ... }.
// A payment counts only when its authorization number is the notify's code, the amount is sum × 100, and it went through.
const agorot = (sum: number) => Math.round(sum * 100);
function matches(r: Record<string, unknown>, code: string, sum: number, d: Diag): boolean {
  d.records++;
  if (!d.keys.length) d.keys = Object.keys(r).slice(0, 60);
  const amtOk = Number(r.amount) === agorot(sum), codeOk = sameCode(String(r.authorization_number ?? ""), code);
  if (amtOk) d.sum_hits++; if (codeOk) d.code_hits++;
  const passed = (r.processor_response_code === undefined || String(r.processor_response_code) === "000") && String(r.txn_type ?? "DEBIT").toUpperCase() !== "CREDIT";
  return amtOk && codeOk && passed;
}
async function verify(code: string, sum: number) {
  const diag: Diag = { pages: 0, records: 0, sum_hits: 0, code_hits: 0, keys: [] };
  for (const d of [day(0), day(1)]) {
    for (let page = 1; page <= 6; page++) {
      const j = await transactions(d, page).catch(() => null);
      const list = j && Array.isArray((j as Record<string, unknown>).transactions) ? (j as Record<string, unknown>).transactions as Record<string, unknown>[] : null;
      if (!list) break;
      diag.pages++;
      if (list.some((r) => r && typeof r === "object" && matches(r, code, sum, diag))) return { ok: true, diag };
      if (!list.length) break; // an empty page: the day is finished
    }
  }
  return { ok: false, diag };
}

// ---- service calls (hook token) ----
// recheck: notifies that could not be confirmed in the last 24 hours are looked up again.
async function recheck() {
  const since = new Date(Date.now() - 24 * 3600e3).toISOString();
  const { data: rows } = await admin.from("crm_audit").select("id, at, detail").eq("action", "pay_notify_unverified").gte("at", since).order("id", { ascending: false }).limit(20);
  // one entry per payment request: the newest code, the time of the first notify, and the task opened for it
  const byId = new Map<number, { code: string; sum: number; at: string; task: number | null }>();
  for (const a of rows || []) {
    const d = (a.detail || {}) as Record<string, unknown>, id = Number(d.id), code = String(d.code || ""), sum = Number(d.sum);
    if (!id || !code || !(sum > 0)) continue;
    const e = byId.get(id);
    if (!e) byId.set(id, { code, sum, at: a.at, task: d.task ? Number(d.task) : null });
    else { e.at = a.at; if (d.task) e.task = Number(d.task); } // rows come newest first, so the last one seen is the first notify
  }
  let fixed = 0, left = 0;
  for (const [id, e] of byId) {
    const { data: pr } = await admin.from("crm_pay_requests").select("id, tail9, amount, status").eq("id", id).maybeSingle();
    if (!pr || pr.status === "paid" || Math.abs(Number(pr.amount) - e.sum) >= 0.005) continue;
    const v = await verify(e.code, e.sum);
    if (!v.ok) { left++; continue; }
    await admin.from("crm_pay_requests").update({ status: "paid", paid_at: e.at, paid_sum: e.sum, verified: true }).eq("id", id).neq("status", "paid");
    if (e.task) await admin.from("crm_tasks").update({ done_at: new Date().toISOString(), done_by: "טרנזילה" }).eq("id", e.task).is("done_at", null);
    await admin.from("crm_audit").insert({ who: "tranzila", action: "pay_paid", tail9: pr.tail9, detail: { id, sum: e.sum, via: "recheck" } });
    fixed++;
  }
  return { ok: true, fixed, left };
}
// shape: a read-only look at the layout of Tranzila's answer, for finding out why a payment was not matched.
// Card, name and contact fields come back as their type only.
const PRIVATE = /card|cc|token|name|mail|phone|holder|exp|cvv|address|contact|tz|myid|id_n|user|city|zip|company|fax/i;
function records(node: unknown, out: Record<string, unknown>[] = [], depth = 0): Record<string, unknown>[] {
  if (depth > 5 || !node || typeof node !== "object") return out;
  if (Array.isArray(node)) { for (const n of node) { if (n && typeof n === "object" && !Array.isArray(n)) out.push(n as Record<string, unknown>); records(n, out, depth + 1); } return out; }
  for (const v of Object.values(node as Record<string, unknown>)) if (v && typeof v === "object") records(v, out, depth + 1);
  return out;
}
async function shape(body: Record<string, unknown>) {
  const sum = Number(body.sum) || 0, days = Math.min(3, Number(body.days) || 1), pages = Math.min(5, Number(body.pages) || 2);
  const out: unknown[] = [];
  for (let d = 0; d < days; d++) for (let p = 1; p <= pages; p++) {
    const j = await transactions(day(d), p).catch(() => null);
    if (!j) { out.push({ day: day(d), page: p, answer: null }); break; }
    const top: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(j as Record<string, unknown>)) top[k] = Array.isArray(v) ? "array(" + v.length + ")" : v && typeof v === "object" ? "object{" + Object.keys(v).join(",") + "}" : PRIVATE.test(k) ? typeof v : v;
    const recs = records(j);
    const hit = recs.filter((r) => Object.values(r).some((v) => (typeof v === "string" || typeof v === "number") && sum > 0 && Math.abs(Number(v) - sum) < 0.005));
    // a few non-personal fields of every transaction (number, time, amounts, status), to see how the amount is written
    const SAFE = ["index", "transaction_time", "amount", "first_payment_amount", "other_payment_amount", "number_of_payments", "currency", "transtatus", "processor_response_code", "tranmode", "txn_type", "txn_payment_method", "child_terminal"];
    const list = Array.isArray((j as Record<string, unknown>).transactions) ? (j as Record<string, unknown>).transactions as Record<string, unknown>[] : [];
    out.push({ day: day(d), page: p, top, records: recs.length, keys: recs[0] ? Object.keys(recs[0]) : [],
      rows: list.slice(0, 50).map((r) => Object.fromEntries(SAFE.filter((k) => k in r).map((k) => [k, r[k]]))),
      hits: hit.slice(0, 6).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, PRIVATE.test(k) ? typeof v : (v && typeof v === "object" ? "object" : v)]))) });
    if (!recs.length) break;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  const hook = req.headers.get("x-hook-token");
  if (hook) {
    const { data: k } = await admin.from("crm_push_keys").select("hook_token").eq("id", 1).maybeSingle();
    if (req.method !== "POST" || !k?.hook_token || k.hook_token !== hook) return json({ ok: false }, 403);
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    if (body.action === "recheck") return json(await recheck());
    if (body.action === "shape") return json(await shape(body));
    return json({ ok: false, error: "action" }, 400);
  }
  // Notify Format can be a query string (QSTR, GET or POST) or a form/JSON body: read both, body wins.
  const f = new URL(req.url).searchParams;
  if (req.method === "POST") {
    try {
      const t = await req.text();
      const b = (req.headers.get("content-type") || "").includes("json") ? Object.entries(JSON.parse(t) as Record<string, unknown>).map(([k, v]) => [k, String(v)]) : [...new URLSearchParams(t)];
      for (const [k, v] of b) f.set(k, v);
    } catch { /* keep query-string fields */ }
  } else if (req.method !== "GET") return ok();
  // Field names only (never values), so we can see what a real notify carries while the setup is new.
  if (f.has("Response") || f.has("sum")) await admin.from("crm_audit").insert({ who: "tranzila", action: "pay_notify_seen", detail: { method: req.method, keys: [...new Set(f.keys())].slice(0, 40), has_pr: f.has("pr_id"), ok: ["000", "0"].includes((f.get("Response") || "").trim()) } });
  const prId = (f.get("pr_id") || "").trim(), code = (f.get("ConfirmationCode") || "").trim();
  const resp = (f.get("Response") || "").trim(), sum = Number(f.get("sum"));
  if (!/^\d{1,12}$/.test(prId) || !(resp === "000" || resp === "0") || !/^[0-9A-Za-z]{1,20}$/.test(code) || !(sum > 0)) return ok();

  const { data: row } = await admin.from("crm_pay_requests").select("id, tail9, amount, status").eq("pr_id", prId).maybeSingle();
  if (!row || row.status === "paid" || Math.abs(Number(row.amount) - sum) >= 0.005) return ok();

  let v = await verify(code, sum);
  if (!v.ok) { await sleep(3000); v = await verify(code, sum); } // the list can be a moment behind the notify
  if (v.ok) {
    await admin.from("crm_pay_requests").update({ status: "paid", paid_at: new Date().toISOString(), paid_sum: sum, verified: true }).eq("id", row.id).neq("status", "paid");
    await admin.from("crm_audit").insert({ who: "tranzila", action: "pay_paid", tail9: row.tail9, detail: { id: row.id, sum } });
    return ok();
  }
  // Not confirmed yet: tell the office once (a task shows in the CRM alerts) and keep the code for the recheck.
  const since = new Date(Date.now() - 24 * 3600e3).toISOString();
  const { data: earlier } = await admin.from("crm_audit").select("id").eq("action", "pay_notify_unverified").gte("at", since).eq("detail->>id", String(row.id)).limit(1);
  let task: number | null = null;
  if (!earlier?.length) {
    const [tk, cu] = await Promise.all([
      admin.from("crm_takings").select("payer_name").eq("pay_pr_id", prId).limit(1).maybeSingle(),
      admin.from("crm_customers").select("name").eq("tail9", row.tail9).is("deleted_at", null).limit(1).maybeSingle(),
    ]);
    const name = String(tk.data?.payer_name || cu.data?.name || "לקוח").trim();
    const { data: t } = await admin.from("crm_tasks").insert({
      tail9: row.tail9, due: new Date().toISOString(), by: "טרנזילה",
      text: "לבדוק תשלום: טרנזילה דיווחה שהתקבלו ₪" + sum.toLocaleString("en-US", { maximumFractionDigits: 2 }) + " מ" + name + " בלינק תשלום, אבל האישור האוטומטי עוד לא הצליח. המערכת בודקת שוב כל דקה. אם זה לא הופך ל\"שולם\" תוך כמה דקות, לבדוק בטרנזילה שהעסקה עברה.",
    }).select("id").maybeSingle();
    task = t?.id ?? null;
  }
  await admin.from("crm_audit").insert({ who: "tranzila", action: "pay_notify_unverified", tail9: row.tail9, detail: { id: row.id, sum, code, task, diag: v.diag } });
  return ok();
});
