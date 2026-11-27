-- Morning list: a short, ordered set of tasks prepared for one morning (who to call, what to say).
-- grp = the heading the row sits under, ord = place in the list, draft = a ready WhatsApp text the staff member sends by hand.
-- Rows with grp never pop up one by one: the home screen shows one count and the "today" screen shows the list.
-- Rows are inserted with notified_at already set, so no per-row reminder goes out.
alter table public.crm_tasks add column if not exists grp text, add column if not exists ord integer, add column if not exists draft text;
create index if not exists crm_tasks_grp_open on public.crm_tasks (due) where grp is not null and done_at is null;

-- Inbox: a first message from an Israeli number that nobody answered yet (not even the bot) must still show as waiting.
-- Before, only local-format numbers or chats with at least one outgoing message were listed, which hid such chats while the bot is down.
do $$
declare d text; old text := $a$and (l.phone ~ '^0[0-9]{8,9}$' or coalesce(a.n_out, 0) > 0)$a$; neu text := $a$and (l.phone ~ '^(0|972)[0-9]{8,9}$' or coalesce(a.n_out, 0) > 0)$a$;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'crm_inbox';
  if position(neu in d) > 0 then return; end if;
  if position(old in d) = 0 then raise exception 'crm_inbox: expected filter not found'; end if;
  execute replace(d, old, neu);
end $$;
