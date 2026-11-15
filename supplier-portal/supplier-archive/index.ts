// supplier-archive (15.11.2026, Aviv: "תוודא גם שכל המחירונים שנשלחים אליך מכל הספקים נמצאים במקום בטוח, שתמיד ניתן
// לגשת אליהם אחר כך אם משהו נופל"). Every original price-list file is kept in the private bucket supplier-files,
// whatever channel brought it. A cron job calls this every 2 minutes, only when there is work. It never sends anything.
//   1. A heavy WhatsApp PDF (file_path 'wa:<media id>', over 20MB) used to live only at WhatsApp, which deletes media
//      after 30 days. It is copied into archive/<supplier>/<upload>/ ; over 45MB it is kept in byte parts (.part1, .part2)
//      because the project allows 50MB a file. Joining the parts in order gives back the exact original file.
//   2. A file that reached us another way (e.g. a supplier's email to Aviv, saved by a Claude session) is put in sp_stash
//      as base64, or as an encrypted blob at fetch_url with key_hex/iv_hex. It is stored in the bucket, recorded in sp_uploads and read like a portal upload; the base64 is then cleared.
// Files that came through the portal or a light WhatsApp file are already in the bucket (archive_paths is set by trigger).
import { createClient } from "npm:@supabase/supabase-js@2";
import { Buffer } from "node:buffer";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SB_URL, SERVICE_KEY);
const PART = 45 * 1024 * 1024;
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const safeKey = (n: string) => { const ext = (n.match(/\.[a-z0-9]{2,5}$/i)?.[0] || "").toLowerCase(); const base = n.slice(0, n.length - ext.length).replace(/[^A-Za-z0-9.\-]+/g, "_").replace(/^_+|_+$/g, "").slice(-60); return (base || "file") + ext; };
const put = async (path: string, bytes: Uint8Array, type: string) => {
  const { error } = await db.storage.from("supplier-files").upload(path, bytes, { contentType: type, upsert: true });
  if (error) throw new Error("store " + error.message);
};

async function archiveWa() {
  const { data: u } = await db.from("sp_uploads").select("id, supplier_id, file_name, file_path, mime, archive_tries")
    .like("file_path", "wa:%").is("archive_paths", null).lt("archive_tries", 5).order("created_at").limit(1).maybeSingle();
  if (!u) return false;
  await db.from("sp_uploads").update({ archive_tries: (u.archive_tries || 0) + 1 }).eq("id", u.id);
  try {
    const { data: cfg } = await db.from("wa_config").select("token").limit(1).maybeSingle();
    const auth = { authorization: `Bearer ${cfg?.token || ""}` };
    const info = await fetch(`https://graph.facebook.com/v23.0/${String(u.file_path).slice(3)}`, { headers: auth }).then((r) => r.json()).catch(() => null);
    if (!info?.url) throw new Error("הקובץ כבר לא זמין בוואטסאפ");
    const r = await fetch(info.url, { headers: auth });
    if (!r.ok || !r.body) throw new Error("הורדה מוואטסאפ נכשלה " + r.status);
    const total = Number(info.file_size) || 0;
    const base = `archive/${u.supplier_id}/${u.id}/${safeKey(String(u.file_name || "file.pdf"))}`;
    const many = total > PART;
    const paths: string[] = [];
    // read the stream into one 45MB buffer at a time, store it, reuse the buffer: memory stays near one part
    const buf = new Uint8Array(PART);
    let fill = 0, n = 0;
    const flush = async () => { if (!fill) return; n++; const p = many ? `${base}.part${n}` : base; await put(p, buf.subarray(0, fill), many ? "application/octet-stream" : (u.mime || "application/pdf")); paths.push(p); fill = 0; };
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let off = 0;
      while (off < value.length) {
        const take = Math.min(value.length - off, PART - fill);
        buf.set(value.subarray(off, off + take), fill); fill += take; off += take;
        if (fill === PART) await flush();
      }
    }
    await flush();
    if (!paths.length) throw new Error("קובץ ריק");
    await db.from("sp_uploads").update({ archive_paths: paths, archived_at: new Date().toISOString(), archive_note: many ? `נשמר ב-${paths.length} חלקים, לחבר לפי הסדר` : null }).eq("id", u.id);
  } catch (e) {
    await db.from("sp_uploads").update({ archive_note: String((e as Error).message || e).slice(0, 200) }).eq("id", u.id);
  }
  return true;
}

async function fromStash() {
  const { data: s } = await db.from("sp_stash").select("*").is("upload_id", null).is("error", null).order("created_at").limit(1).maybeSingle();
  if (!s) return false;
  try {
    let bytes: Uint8Array;
    if (s.fetch_url) {
      // a file handed over as an AES-256-CBC encrypted blob at a URL; the key is kept here only until the file is stored
      const r = await fetch(s.fetch_url);
      if (!r.ok) throw new Error("fetch " + r.status);
      const hex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
      const k = await crypto.subtle.importKey("raw", hex(s.key_hex), { name: "AES-CBC" }, false, ["decrypt"]);
      bytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: hex(s.iv_hex) }, k, await r.arrayBuffer()));
    } else bytes = new Uint8Array(Buffer.from(String(s.b64 || ""), "base64"));
    if (!bytes.length) throw new Error("empty");
    const name = String(s.file_name || "file");
    const path = `${s.supplier_id}/${Date.now()}_${safeKey(name)}`;
    await put(path, bytes, s.mime || "application/octet-stream");
    const { data: row, error } = await db.from("sp_uploads").insert({
      supplier_id: s.supplier_id, file_path: path, file_name: name.slice(-120), mime: s.mime || null, size_bytes: bytes.length,
      source: s.source || "email", uploader_name: s.uploader_name, supplier_name_typed: s.supplier_name_typed, supplier_note: s.note,
    }).select("id").single();
    if (error || !row) throw new Error("db " + (error?.message || ""));
    await db.from("sp_stash").update({ upload_id: row.id, b64: null, key_hex: null, iv_hex: null, done_at: new Date().toISOString() }).eq("id", s.id);
    await db.from("sp_suppliers").update({ last_upload_at: new Date().toISOString() }).eq("id", s.supplier_id);
    await fetch(`${SB_URL}/functions/v1/supplier-upload`, { method: "POST", headers: { "content-type": "application/json", "x-sp-key": SERVICE_KEY }, body: JSON.stringify({ reparse: row.id }) }).catch(() => {});
  } catch (e) {
    await db.from("sp_stash").update({ error: String((e as Error).message || e).slice(0, 200) }).eq("id", s.id);
  }
  return true;
}

Deno.serve((req) => {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  // @ts-ignore EdgeRuntime is provided by Supabase
  EdgeRuntime.waitUntil((async () => { await fromStash(); await archiveWa(); })());
  return json({ ok: true }, 202);
});
