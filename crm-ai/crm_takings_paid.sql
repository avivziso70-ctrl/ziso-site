-- 12.11.2026: a card payment link is "waiting" (yellow) until Tranzila confirms it. Only then: paid_at is set (green),
-- the urgent receipt task is opened, and every staff device gets a push alert. Other methods open the task at once.
alter table public.crm_takings add column if not exists paid_at timestamptz;

create or replace function public.crm_takings_task() returns trigger language plpgsql set search_path to 'public' as $$
declare
  m text; who text; v_task bigint;
begin
  m := case new.method when 'cash' then 'במזומן' when 'cheque' then 'בצ׳ק' when 'transfer' then 'בהעברה או ביט'
       when 'card_terminal' then 'באשראי (חויב במסוף)' else 'באשראי (לינק תשלום, שולם ואושר בטרנזילה)' end
       || case when new.payments > 1 then ' ב-' || new.payments || ' תשלומים' else '' end;
  -- "by" is a reserved word: it must stay quoted inside plpgsql
  who := coalesce((select s.name from crm_staff s where lower(s.email) = lower(new."by") limit 1), new."by");
  if tg_op = 'INSERT' then
    if new.method = 'card_link' and new.paid_at is null then return new; end if; -- no receipt before the money arrives
    insert into crm_tasks (tail9, text, due, "by")
    values (new.tail9,
      'דחוף, להוציא קבלה: ' || who || ' קיבל ₪' || to_char(new.amount, 'FM999G999G990D00') || ' ' || m || ' מ' || btrim(new.payer_name)
      || '. סיבה: ' || btrim(new.reason)
      || '. סחורה שנלקחה: ' || case when new.goods_taken then btrim(new.goods) else 'לא נלקחה' end
      || '. להקליד בפריוריטי ולסגור כאן עם מספר המסמך.',
      now(), new."by")
    returning id into new.task_id;
    return new;
  end if;
  -- the link was paid: now the receipt task opens (unless an open one already exists from before this change)
  if new.paid_at is not null and old.paid_at is null and new.closed_at is null and new.cancelled_at is null
     and not exists (select 1 from crm_tasks k where k.id = new.task_id and k.done_at is null) then
    insert into crm_tasks (tail9, text, due, "by")
    values (new.tail9,
      'דחוף, להוציא קבלה: ' || who || ' קיבל ₪' || to_char(new.amount, 'FM999G999G990D00') || ' ' || m || ' מ' || btrim(new.payer_name)
      || '. סיבה: ' || btrim(new.reason)
      || '. סחורה שנלקחה: ' || case when new.goods_taken then btrim(new.goods) else 'לא נלקחה' end
      || '. להקליד בפריוריטי ולסגור כאן עם מספר המסמך.',
      now(), new."by")
    returning id into v_task;
    update crm_takings set task_id = v_task where id = new.id;
    return new;
  end if;
  if new.task_id is not null and ((new.closed_at is not null and old.closed_at is null) or (new.cancelled_at is not null and old.cancelled_at is null)) then
    update crm_tasks set done_at = now(), done_by = coalesce(new.closed_by, new.cancelled_by) where id = new.task_id and done_at is null;
  end if;
  return new;
end $$;

-- Tranzila confirmed a payment request (crm-pay-notify sets status 'paid' only after checking Tranzila's own API)
create or replace function public.crm_pay_paid() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_token text; v_name text;
begin
  -- a taking the staff cancelled as "not paid" comes back to life if the customer paid after all
  update crm_takings set paid_at = coalesce(new.paid_at, now()), cancelled_at = null, cancelled_by = null, cancel_note = null
   where pay_pr_id = new.pr_id and paid_at is null and closed_at is null
   returning payer_name into v_name;
  begin
    if v_name is null then
      select c.name into v_name from crm_customers c where c.tail9 = new.tail9 and c.deleted_at is null limit 1;
    end if;
    select hook_token into v_token from crm_push_keys where id = 1;
    perform net.http_post(
      url := 'https://ppnjosyraosrdephsksu.supabase.co/functions/v1/crm-push',
      headers := jsonb_build_object('content-type', 'application/json', 'x-hook-token', v_token),
      body := jsonb_build_object('action', 'notify', 'phone', '0' || new.tail9, 'type', 'pay',
        'name', '✅ שולם ₪' || to_char(coalesce(new.paid_sum, new.amount), 'FM999G999G990D00') || ' · ' || coalesce(v_name, 'לקוח'),
        'text', 'התשלום באשראי אושר בטרנזילה. עכשיו אפשר להוציא קבלה בפריוריטי.'));
  exception when others then null; -- an alert problem never blocks the payment update
  end;
  return new;
end $$;
create trigger crm_pay_paid_trg after update of status on public.crm_pay_requests
  for each row when (new.status = 'paid' and old.status is distinct from 'paid') execute function public.crm_pay_paid();
