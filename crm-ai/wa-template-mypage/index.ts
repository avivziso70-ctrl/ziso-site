// wa-template-mypage (17.11.2026): submits the UTILITY template ziso_my_page to Meta for review, or reports its status
// if it already exists. Wording approved by Aviv 17.11 unchanged (relayed by the coordinator). Takes no input, never
// returns the token. Safe to call again: when the template exists it only reads.
import { createClient } from "npm:@supabase/supabase-js@2";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const G = "https://graph.facebook.com/v23.0";
const NAME = "ziso_my_page";
const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
const TEXT = "שלום {{1}}, כאן זיסו קרמיקה. פתחנו לך דף אישי עם ההזמנות, הקבלות והחשבוניות שלך, שמתעדכן לבד. אפשר גם לכתוב לנו דרכו. {{2}}\n" +
  "בכניסה מקלידים את 4 הספרות האחרונות של הטלפון. לא צריך את הדף? אפשר לסגור אותו בלחיצה בתחתית הדף.";

Deno.serve(async () => {
  const { data: cfg } = await db.from("wa_config").select("token, waba_id").eq("id", 1).maybeSingle();
  if (!cfg?.token || !cfg?.waba_id) return json({ ok: false, error: "wa_config empty" });
  const h = { Authorization: `Bearer ${cfg.token}` };
  const ex = await (await fetch(`${G}/${cfg.waba_id}/message_templates?name=${NAME}&fields=name,status,category,language,rejected_reason`, { headers: h })).json().catch(() => ({}));
  if (ex.data?.length) return json({ ok: true, exists: true, templates: ex.data });
  if (ex.error) return json({ ok: false, step: "lookup", error: ex.error.message });
  const body = {
    name: NAME, language: "he", category: "UTILITY",
    components: [{ type: "BODY", text: TEXT, example: { body_text: [["דנה", "https://www.zisoceramics.com/my/#AbCdEfGhIjKlMnOpQrStUvWx"]] } }],
  };
  const r = await fetch(`${G}/${cfg.waba_id}/message_templates`, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return json({ ok: r.ok, http: r.status, id: j.id, status: j.status, category: j.category, error: j.error ? { message: j.error.message, user_msg: j.error.error_user_msg, code: j.error.code } : null });
});
