// crm-my-pics (17.11.2026): catalog pictures for the products on a customer's page (Aviv: "וגם את התמונה של הפריט אם יש").
// POST { token, pin } -> { ok, pics: [{ i, url }] }. Gate and line matching are in SQL (crm_my_pics); links last one hour.
import { createClient } from "npm:@supabase/supabase-js@2";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, apikey, authorization", "access-control-allow-methods": "POST, OPTIONS" };
const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return out({ ok: false, error: "method" }, 405);
  let b: any = {};
  try { b = await req.json(); } catch { return out({ ok: false, error: "bad" }, 400); }
  const { data, error } = await db.rpc("crm_my_pics", { p_token: String(b.token || "").slice(0, 64), p_pin: String(b.pin || "").slice(0, 8) });
  if (error) return out({ ok: false, error: "server" }, 500);
  if (!data?.ok) return out({ ok: false, error: data?.error || "gate" });
  const pics = (data.pics || []).slice(0, 200) as { i: number; path: string }[];
  if (!pics.length) return out({ ok: true, pics: [] });
  const { data: s } = await db.storage.from("supplier-files").createSignedUrls([...new Set(pics.map((p) => p.path))], 3600);
  const url: Record<string, string> = {};
  (s || []).forEach((x: any) => { if (x.signedUrl) url[x.path] = x.signedUrl; });
  return out({ ok: true, pics: pics.filter((p) => url[p.path]).map((p) => ({ i: p.i, url: url[p.path] })) });
});
