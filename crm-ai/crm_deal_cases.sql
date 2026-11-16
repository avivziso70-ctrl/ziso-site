-- What happens to a product after it was ordered (phase 3 of the deal flow).
-- Aviv 15.11.2026: "שיפוץ, זה תהליך... לפעמים הם משנים את דעתם. לפעמים דברים מגיעים פגומים ואז יש החזרות."
-- One row per event on one product line: a change of mind, a cancellation, a defect, a return.
-- The customer sees its state on the live page (crm_my); a credit or a refund opens a task, because until the
-- business leaves Priority the credit note and the refund receipt are still issued there.
-- Apply after crm_my.sql. No DROP in this file.

create table if not exists public.crm_deal_cases (
  id bigint generated always as identity primary key,
  deal_id bigint not null references public.crm_deals (id),
  lid text not null,                                            -- the line's id inside crm_deals.lines
  line_desc text,
  kind text not null check (kind in ('change', 'cancel', 'defect', 'return')),
  qty numeric,
  text text check (text is null or length(text) <= 1000),      -- internal note
  status text not null default 'open' check (status in ('open', 'supplier', 'done')),
  outcome text check (outcome in ('replaced', 'credited', 'refunded', 'cancelled', 'none')),
  log jsonb not null default '[]'::jsonb,                       -- who changed what, when
  "by" text, by_name text,
  task_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists crm_deal_cases_deal_idx on public.crm_deal_cases (deal_id);
alter table public.crm_deal_cases enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'crm_deal_cases' and policyname = 'staff read') then
    create policy "staff read" on public.crm_deal_cases for select using (public.crm_me() is not null);
    create policy "staff add" on public.crm_deal_cases for insert with check (public.crm_me() is not null);
    create policy "staff update" on public.crm_deal_cases for update using (public.crm_me() is not null) with check (public.crm_me() is not null);
  end if;
end $$;

-- Every change is written to the log by the database, not by the page. A credit or a refund opens one task.
create or replace function public.crm_deal_case_trg() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare d crm_deals; v_who text := coalesce(public.crm_me(), new."by", 'מערכת');
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.log := jsonb_build_array(jsonb_build_object('at', now(), 'by', v_who, 'status', new.status, 'outcome', new.outcome));
  elsif new.status is distinct from old.status or new.outcome is distinct from old.outcome then
    new.log := coalesce(old.log, '[]'::jsonb) || jsonb_build_object('at', now(), 'by', v_who, 'status', new.status, 'outcome', new.outcome);
  else
    new.log := old.log;
  end if;
  if new.outcome in ('credited', 'refunded') and new.task_id is null and (tg_op = 'INSERT' or new.outcome is distinct from old.outcome) then
    select * into d from crm_deals where id = new.deal_id;
    insert into crm_tasks (tail9, text, due, "by") values (d.customer_tail9,
      case new.outcome when 'refunded' then 'להחזיר כסף ללקוח ולהוציא קבלת החזר וחשבונית זיכוי בפריוריטי' else 'להוציא חשבונית זיכוי בפריוריטי' end
      || ' · ' || d.deal_no || ' · ' || coalesce(d.customer_name, '') || ': ' || coalesce(new.line_desc, 'מוצר') || coalesce(' × ' || trim(to_char(new.qty, 'FM999990.##')), '')
      || ' (' || case new.kind when 'defect' then 'פגום' when 'return' then 'החזרה' when 'cancel' then 'ביטול' else 'שינוי' end || ').',
      now(), coalesce(new."by", 'תיק עסקה')) returning id into new.task_id;
    perform crm_po_push('↩ ' || case new.outcome when 'refunded' then 'החזר כספי' else 'זיכוי' end || ' · ' || coalesce(d.customer_name, d.deal_no), coalesce(new.line_desc, '') || ' · צריך מסמך בפריוריטי');
  end if;
  return new;
end $$;
create or replace trigger crm_deal_case_trg before insert or update on public.crm_deal_cases for each row execute function public.crm_deal_case_trg();
revoke all on function public.crm_deal_case_trg() from public, anon, authenticated;
