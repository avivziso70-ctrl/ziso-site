// books-reader: the owner creates a read-only sign-in for a bookkeeper.
// The caller must be the owner (checked with the caller's own token). The password is typed by the owner
// in the books page, is never logged, and the new user must replace it on first sign-in.
import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const J = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return J({ ok: false, error: "method" }, 405);
  const url = Deno.env.get("SUPABASE_URL")!;
  const auth = req.headers.get("authorization") || "";
  const asCaller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
  const own = await asCaller.rpc("crm_is_owner");
  if (own.error || own.data !== true) return J({ ok: false, error: "owner_only" }, 403);
  const me = await asCaller.rpc("crm_me");

  let b: { email?: string; name?: string; password?: string };
  try { b = await req.json(); } catch { return J({ ok: false, error: "bad_json" }, 400); }
  const email = String(b.email || "").trim().toLowerCase();
  const name = String(b.name || "").trim().slice(0, 80);
  const password = String(b.password || "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return J({ ok: false, error: "bad_email" }, 400);

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const staff = await admin.from("crm_staff").select("email").ilike("email", email).maybeSingle();
  let created = false;
  if (!staff.data) {
    // Not a staff member: make (or refresh) the sign-in. A staff member keeps the sign-in they already have.
    if (password.length < 10) return J({ ok: false, error: "short_password" }, 400);
    const meta = { must_change_pw: true, books_reader: true };
    const mk = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: meta });
    if (mk.error) {
      const list = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      const u = (list.data?.users || []).find((x) => (x.email || "").toLowerCase() === email);
      if (!u) return J({ ok: false, error: "create_failed" }, 500);
      const up = await admin.auth.admin.updateUserById(u.id, { password, user_metadata: { ...(u.user_metadata || {}), ...meta } });
      if (up.error) return J({ ok: false, error: "update_failed" }, 500);
    } else created = true;
  }
  const row = await admin.from("acc_readers").upsert(
    { email, name: name || null, active: true, added_by: String(me.data || "") }, { onConflict: "email" });
  if (row.error) return J({ ok: false, error: "save_failed" }, 500);
  await admin.from("acc_access_log").insert({ email: String(me.data || ""), screen: "reader_create", args: { email, created, staff: !!staff.data } });
  return J({ ok: true, created, staff: !!staff.data });
});
