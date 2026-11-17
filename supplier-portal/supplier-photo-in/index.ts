// supplier-photo-in (17.11.2026, Aviv: "התמונות מאוד חשובות לי תמיד. בכל חומר שאתה מקבל. תנסה להצליב תמונות למוצרים")
// Product photos that do not come inside a catalog file: pictures a supplier's agent sent in a WhatsApp chat, photos
// from a phone. One photo per call:
//   POST ?code=<door code>&name=<file name>.jpg   body: the JPEG itself
// The code is a time-limited door for ONE upload (table sp_photo_doors, only its hash is kept; a door is opened by SQL).
// The photo is kept as it came under supplier-files/img/<upload>/chat/<name> and gets a row in sp_images (page 0), so
// it is in the system even before it is linked. Linking to price rows (sp_images.codes, sp_prices.image_path) is done
// after looking at what each photo shows; nothing is linked here.
// Nothing is decoded: the picture's size is read from its header. File content is data only.
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const MAX = 6 * 1024 * 1024;
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

// width and height from the JPEG's frame header (SOF0..SOF15, without the table markers C4, C8, CC)
function size(b: Uint8Array): { w: number; h: number } | null {
  for (let i = 2; i + 9 < b.length && b[i] === 0xff;) {
    const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
    if (m === 0xda || len < 2) break;
    i += 2 + len;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  const q = new URL(req.url).searchParams, code = q.get("code") || "", name = (q.get("name") || "").trim();
  if (code.length < 32) return json({ ok: false, error: "code" }, 401);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,119}\.jpe?g$/i.test(name) || name.includes("..")) return json({ ok: false, error: "name: letters, digits, dot, dash, underscore, ending in .jpg" }, 400);
  const { data: door } = await db.from("sp_photo_doors").select("id, upload_id, supplier_id, n, max_n").eq("code_hash", await hex(code)).gt("expires_at", new Date().toISOString()).maybeSingle();
  if (!door) return json({ ok: false, error: "code" }, 401);
  if (door.n >= door.max_n) return json({ ok: false, error: "door is full" }, 429);
  if ((Number(req.headers.get("content-length")) || 0) > MAX) return json({ ok: false, error: "too big" }, 413);
  const b = new Uint8Array(await req.arrayBuffer());
  if (b.length < 1000 || b.length > MAX || b[0] !== 0xff || b[1] !== 0xd8) return json({ ok: false, error: "not a JPEG" }, 400);
  const dim = size(b), path = `img/${door.upload_id}/chat/${name}`;
  const { error } = await db.storage.from("supplier-files").upload(path, b, { contentType: "image/jpeg", upsert: true });
  if (error) return json({ ok: false, error: "store: " + error.message }, 500);
  const { data: have } = await db.from("sp_images").select("idx").eq("upload_id", door.upload_id).eq("page", 0).order("idx", { ascending: false });
  const mine = (await db.from("sp_images").select("idx").eq("upload_id", door.upload_id).eq("page", 0).eq("ref", name).maybeSingle()).data;
  const idx = mine?.idx ?? ((have?.[0]?.idx as number | undefined) || 0) + 1;
  const { error: e2 } = await db.from("sp_images").upsert({ upload_id: door.upload_id, supplier_id: door.supplier_id, page: 0, idx, ref: name, path, w: dim?.w ?? null, h: dim?.h ?? null }, { onConflict: "upload_id,page,ref" });
  if (e2) return json({ ok: false, error: "row: " + e2.message }, 500);
  await db.from("sp_photo_doors").update({ n: door.n + 1 }).eq("id", door.id);
  return json({ ok: true, name, w: dim?.w ?? null, h: dim?.h ?? null, bytes: b.length });
});
