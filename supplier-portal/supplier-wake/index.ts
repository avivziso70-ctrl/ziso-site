// supplier-wake: calls one of the supplier functions again after a short pause.
// supplier-images works in slices and has no timer of its own. When it takes a slice it asks here to be called again
// a little after its lease runs out, so a slice that was killed half way (memory or CPU limit) is picked up again
// instead of leaving the file stuck. The pause is spent asleep, in this function's own worker, so it survives when
// the other worker dies. Nothing is read or written here.
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const ALLOWED = new Set(["supplier-images"]);

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  const b = await req.json().catch(() => ({}));
  const fn = String(b?.fn || ""), after = Math.min(70, Math.max(1, Number(b?.after) || 60)); // a worker lives about 150 seconds
  if (!ALLOWED.has(fn)) return new Response("unknown function", { status: 400 });
  const later = new Promise((r) => setTimeout(r, after * 1000))
    .then(() => fetch(`${SB_URL}/functions/v1/${fn}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))
    .then((r) => r.body?.cancel()).catch(() => {});
  // @ts-ignore EdgeRuntime is provided by Supabase
  EdgeRuntime.waitUntil(later);
  return new Response("ok", { status: 202 });
});
