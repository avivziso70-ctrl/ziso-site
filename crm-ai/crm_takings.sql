-- Money taken at the showroom (phone page /crm/kupa.html). Every row opens an urgent CRM task:
-- the office issues the receipt/invoice in Priority, then closes the row with the document number.
create table public.crm_takings (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  by text not null,
  amount numeric not null check (amount > 0 and amount <= 200000),
  method text not null check (method in ('card_link','card_terminal','cash','cheque','transfer')),
  payer_name text not null check (length(btrim(payer_name)) >= 2),
  tail9 text check (tail9 is null or tail9 ~ '^[0-9]{9}$'),
  reason text not null check (length(btrim(reason)) >= 3),
  goods_taken boolean not null,
  goods text,
  pay_pr_id text,
  task_id bigint,
  doc_no text,
  closed_at timestamptz,
  closed_by text,
  cancelled_at timestamptz,
  cancelled_by text,
  cancel_note text,
  constraint crm_takings_goods_named check (not goods_taken or length(btrim(coalesce(goods, ''))) >= 3),
  constraint crm_takings_card_phone check (method <> 'card_link' or tail9 is not null),
  constraint crm_takings_closed_doc check (closed_at is null or length(btrim(coalesce(doc_no, ''))) >= 2),
  constraint crm_takings_cancel_note check (cancelled_at is null or length(btrim(coalesce(cancel_note, ''))) >= 3)
);
create index crm_takings_open on public.crm_takings (at desc) where closed_at is null and cancelled_at is null;

alter table public.crm_takings enable row level security;
create policy crm_takings_read on public.crm_takings for select to authenticated using (crm_me() is not null);
create policy crm_takings_ins on public.crm_takings for insert to authenticated with check (by = crm_me());
create policy crm_takings_upd on public.crm_takings for update to authenticated using (crm_me() is not null) with check (crm_me() is not null);
-- no delete policy: a taking is never erased, only closed with a document number or cancelled with a reason

create function public.crm_takings_task() returns trigger language plpgsql set search_path to 'public' as $$
declare
  m text := case new.method when 'cash' then 'במזומן' when 'cheque' then 'בצ׳ק' when 'transfer' then 'בהעברה או ביט'
            when 'card_terminal' then 'באשראי (חויב במסוף)' else 'באשראי (לינק תשלום, לוודא שהתשלום עבר)' end;
  who text := coalesce((select name from crm_staff where lower(email) = lower(new.by) limit 1), new.by);
begin
  if tg_op = 'INSERT' then
    insert into crm_tasks (tail9, text, due, by)
    values (new.tail9,
      'דחוף, להוציא קבלה: ' || who || ' קיבל ₪' || to_char(new.amount, 'FM999G999G990D00') || ' ' || m || ' מ' || btrim(new.payer_name)
      || '. סיבה: ' || btrim(new.reason)
      || '. סחורה שנלקחה: ' || case when new.goods_taken then btrim(new.goods) else 'לא נלקחה' end
      || '. להקליד בפריוריטי ולסגור כאן עם מספר המסמך.',
      now(), new.by)
    returning id into new.task_id;
    return new;
  end if;
  if new.task_id is not null and ((new.closed_at is not null and old.closed_at is null) or (new.cancelled_at is not null and old.cancelled_at is null)) then
    update crm_tasks set done_at = now(), done_by = coalesce(new.closed_by, new.cancelled_by) where id = new.task_id and done_at is null;
  end if;
  return new;
end $$;
create trigger crm_takings_task_ins before insert on public.crm_takings for each row execute function public.crm_takings_task();
create trigger crm_takings_task_upd after update on public.crm_takings for each row execute function public.crm_takings_task();
