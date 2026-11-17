// crm-my-doc (17.11.2026): the customer's page asks for the PDF of one of their own receipts / invoices.
// POST { token, pin, doc } -> { ok, state: 'ready', url } | { ok, state: 'pending' } | { ok, state: 'unavailable' } | { ok: false, error }
// All checks are in SQL (crm_my_doc: link + phone digits gate, the document belongs to that customer). The link is signed
// for 5 minutes on the private bucket priority-docs. Nothing here is reachable without the link's secret and the digits.
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, apikey, authorization", "access-control-allow-methods": "POST, OPTIONS" };
const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return out({ ok: false, error: "method" }, 405);
  let b: any = {};
  try { b = await req.json(); } catch { return out({ ok: false, error: "bad" }, 400); }
  const token = String(b.token || "").slice(0, 64), pin = String(b.pin || "").slice(0, 8), doc = String(b.doc || "").slice(0, 20).toUpperCase();
  const { data, error } = await db.rpc("crm_my_doc", { p_token: token, p_pin: pin, p_doc: doc });
  if (error) return out({ ok: false, error: "server" }, 500);
  if (!data?.ok) return out({ ok: false, error: data?.error || "doc" });
  if (data.state !== "ready") return out({ ok: true, state: data.state });
  const name = `ziso-${data.kind === "invoice" ? "invoice" : "receipt"}-${doc}.pdf`;
  const { data: s, error: e2 } = await db.storage.from("priority-docs").createSignedUrl(data.path, 300, { download: name });
  if (e2 || !s?.signedUrl) return out({ ok: false, error: "server" }, 500);
  return out({ ok: true, state: "ready", url: s.signedUrl });
});
