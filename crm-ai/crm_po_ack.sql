-- 15.11.2026 (Aviv): "שהמערכת תאזין תמיד לפידבק מהספק. אם ביטלתי, שגורם מטעמו יאשר שבוטל. אם הזמנתי, שגורם מטעמו יאשר שההזמנה אושרה."
-- Applied as migration crm_po_ack.
alter table public.crm_po
  add column if not exists cancel_ack text,                 -- waiting | confirmed | attention (null = the supplier was never told)
  add column if not exists cancel_ack_at timestamptz,
  add column if not exists cancel_confirmed_at timestamptz,
  add column if not exists cancel_summary text,
  add column if not exists cancel_thread_id text,           -- Gmail thread of the cancellation mail
  add column if not exists cancel_msg_id text,
  add column if not exists cancel_task_id bigint,
  add column if not exists nudge_task_id bigint,            -- "no answer yet, call him" task for the order
  add column if not exists nudged_at timestamptz,
  add column if not exists cancel_nudge_task_id bigint,
  add column if not exists cancel_nudged_at timestamptz;

-- cancellations already sent before this release: still waiting for the supplier
update public.crm_po set cancel_ack = 'waiting'
 where status = 'cancelled' and cancel_ack is null and (cancel_email_state in ('sent', 'unknown', 'queued', 'sending') or cancel_wa_state = 'sent');

-- WhatsApp answers: also for cancellations waiting for him; an order still waiting for an answer comes first
create or replace function public.crm_po_wa_in() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_po bigint; v_token text; t9 text;
begin
  if new.dir <> 'in' or coalesce(new.source, '') <> 'live' then return new; end if;
  t9 := right(regexp_replace(coalesce(new.phone, ''), '\D', '', 'g'), 9);
  if length(t9) < 9 then return new; end if;
  select id into v_po from crm_po where channel in ('whatsapp', 'both') and right(regexp_replace(coalesce(to_phone, ''), '\D', '', 'g'), 9) = t9
    and ((status in ('sent', 'attention', 'confirmed') and sent_at > now() - interval '45 days')
      or (status = 'cancelled' and cancel_ack in ('waiting', 'attention') and cancelled_at > now() - interval '45 days'))
    order by (status = 'sent' or cancel_ack = 'waiting') desc, greatest(sent_at, coalesce(cancelled_at, sent_at)) desc limit 1;
  if v_po is null then return new; end if;
  begin
    select hook_token into v_token from crm_push_keys where id = 1;
    perform net.http_post(
      url := 'https://ppnjosyraosrdephsksu.supabase.co/functions/v1/crm-po',
      headers := jsonb_build_object('content-type', 'application/json', 'x-hook-token', v_token),
      body := jsonb_build_object('action', 'wa_reply', 'id', v_po, 'msg_id', new.id, 'from', new.phone, 'date', new.ts, 'type', new.type,
        'text', coalesce(new.text, new.raw #>> '{button,text}', new.raw #>> '{interactive,button_reply,title}', '')));
  exception when others then null; -- an order problem never blocks storing the message
  end;
  return new;
end $$;

create or replace function public.crm_po_push(p_name text, p_text text) returns void language plpgsql security definer set search_path to 'public' as $$
declare v_token text;
begin
  select hook_token into v_token from crm_push_keys where id = 1;
  perform net.http_post(
    url := 'https://ppnjosyraosrdephsksu.supabase.co/functions/v1/crm-push',
    headers := jsonb_build_object('content-type', 'application/json', 'x-hook-token', v_token),
    body := jsonb_build_object('action', 'notify', 'phone', '0000000000', 'type', 'pay', 'name', p_name, 'text', p_text));
exception when others then null; -- an alert problem never blocks the order record
end $$;
revoke all on function public.crm_po_push(text, text) from public, anon, authenticated;

-- the supplier answered a cancellation: push; anything but a clear "cancelled" also opens a task
create or replace function public.crm_po_cancel_notify() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_task bigint; head text;
begin
  if new.cancel_ack is not distinct from old.cancel_ack or new.cancel_ack not in ('confirmed', 'attention') then return new; end if;
  head := coalesce(new.supplier_name, 'ספק') || ' · ביטול ' || new.po_no;
  if new.cancel_ack = 'attention' then
    insert into crm_tasks (tail9, text, due, "by") values (null,
      'לבדוק תשובה של ' || coalesce(new.contact, new.supplier_name, 'הספק') || ' על ביטול הזמנה ' || new.po_no || ': '
      || coalesce(new.cancel_summary, 'לא ברור שהביטול התקבל') || '. כדאי להתקשר ולוודא שהסחורה לא יוצאת.', now(), new."by") returning id into v_task;
    update crm_po set cancel_task_id = v_task where id = new.id;
  end if;
  perform crm_po_push(case when new.cancel_ack = 'confirmed' then '✓ הביטול אושר ' else '⚠ לבדוק ' end || head,
    coalesce(new.cancel_summary, case when new.cancel_ack = 'confirmed' then 'הספק אישר שההזמנה בוטלה.' else 'צריך לבדוק את תשובת הספק לביטול.' end));
  return new;
end $$;
drop trigger if exists crm_po_cancel_notify_trg on public.crm_po;
create trigger crm_po_cancel_notify_trg after update of cancel_ack on public.crm_po for each row execute function public.crm_po_cancel_notify();

-- no answer in time (working hours only): one call-the-supplier task + push per order and per cancellation.
-- Order: 3 hours without any answer. Cancellation: 2 hours without a confirmation.
create or replace function public.crm_po_overdue() returns int language plpgsql security definer set search_path to 'public' as $$
declare r record; v_task bigint; n int := 0; loc timestamp := now() at time zone 'Asia/Jerusalem'; d int; hm int;
begin
  d := extract(dow from loc); hm := extract(hour from loc) * 100 + extract(minute from loc);
  if d = 6 or hm < 800 or (d = 5 and hm > 1330) or hm > 1800 then return 0; end if;
  for r in select * from crm_po where status = 'sent' and nudged_at is null and sent_at < now() - interval '3 hours' and sent_at > now() - interval '30 days' loop
    insert into crm_tasks (tail9, text, due, "by") values (null,
      'אין עדיין אישור מ' || coalesce(r.contact, r.supplier_name, 'הספק') || ' (' || coalesce(r.supplier_name, '') || ') על הזמנה ' || r.po_no
      || ' שנשלחה ' || to_char(r.sent_at at time zone 'Asia/Jerusalem', 'DD/MM HH24:MI') || ' (₪' || to_char(r.total_cost, 'FM999G999G990') || ' לפני מע"מ). להתקשר ולוודא שההזמנה התקבלה ואושרה.',
      now(), r."by") returning id into v_task;
    update crm_po set nudged_at = now(), nudge_task_id = v_task where id = r.id;
    perform crm_po_push('⏰ אין אישור · ' || coalesce(r.supplier_name, 'ספק') || ' · ' || r.po_no, 'הספק עוד לא אישר את ההזמנה. כדאי להתקשר.');
    n := n + 1;
  end loop;
  for r in select * from crm_po where status = 'cancelled' and cancel_ack = 'waiting' and cancel_nudged_at is null and cancelled_at < now() - interval '2 hours' and cancelled_at > now() - interval '30 days' loop
    insert into crm_tasks (tail9, text, due, "by") values (null,
      'אין עדיין אישור מ' || coalesce(r.contact, r.supplier_name, 'הספק') || ' שהזמנה ' || r.po_no || ' בוטלה (הביטול נשלח '
      || to_char(r.cancelled_at at time zone 'Asia/Jerusalem', 'DD/MM HH24:MI') || '). להתקשר ולוודא שהסחורה לא יוצאת.',
      now(), r."by") returning id into v_task;
    update crm_po set cancel_nudged_at = now(), cancel_nudge_task_id = v_task where id = r.id;
    perform crm_po_push('⏰ ביטול לא אושר · ' || coalesce(r.supplier_name, 'ספק') || ' · ' || r.po_no, 'הספק עוד לא אישר את הביטול. כדאי להתקשר.');
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.crm_po_overdue() from public, anon, authenticated;
select cron.schedule('crm-po-overdue', '*/15 * * * *', 'select public.crm_po_overdue()');
