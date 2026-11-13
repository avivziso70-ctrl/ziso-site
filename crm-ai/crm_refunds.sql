-- 13.11.2026 (Aviv: "תבנה לי מנגנון מהיר גם להחזיר כסף באשראי. מהמערכות שבנינו כבר מהקופה")
-- Card refunds from the till page (kupa.html) through edge function crm-refund. The page never writes here directly:
-- staff read; only the edge function (service role) inserts and updates, after checking Tranzila's own list.

create table if not exists public.crm_refunds (
  id bigserial primary key,
  at timestamptz not null default now(),
  "by" text not null,                       -- staff email
  tz_index text not null,                   -- Tranzila transaction number of the ORIGINAL charge
  tz_day date not null,                     -- day of the original charge (Israel time)
  orig_amount numeric(12,2) not null,
  amount numeric(12,2) not null check (amount > 0),
  reason text not null check (length(btrim(reason)) >= 3),
  payer_name text,
  tail9 text,
  status text not null default 'pending' check (status in ('pending', 'done', 'failed', 'unknown', 'checked_not_done')),
  response_code text,
  refund_index text,                        -- Tranzila number of the refund itself, when returned
  refund_auth text,
  error text,
  task_id bigint,
  resolved_by text,
  resolved_at timestamptz,
  check (amount <= orig_amount)
);
-- one open refund per charge at a time: a double press or two phones can't refund twice in parallel
create unique index if not exists crm_refunds_one_open on public.crm_refunds (tz_index) where status in ('pending', 'unknown');
alter table public.crm_refunds enable row level security;
drop policy if exists crm_refunds_read on public.crm_refunds;
create policy crm_refunds_read on public.crm_refunds for select using (crm_me() is not null);

-- terminal passwords needed for a refund (Tranzila TranzilaPW + CreditPass). No policy at all: only the service role
-- (edge functions) can read or write. The till page shows only whether they are set, never the values.
create table if not exists public.crm_secrets (k text primary key, v text not null, updated_by text, updated_at timestamptz default now());
alter table public.crm_secrets enable row level security;

-- the switch: refunds stay off until Aviv approves after a real ₪1 test
alter table public.crm_settings add column if not exists refunds_on boolean not null default false;

-- a refund that went through opens an urgent task for the office (credit invoice in Priority) and pushes to all phones;
-- a refund whose result is unknown opens a task to check it in Tranzila.
create or replace function public.crm_refunds_task() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare who text; v_task bigint; v_token text; txt text;
begin
  if new.status not in ('done', 'unknown') or old.status = new.status then return new; end if;
  who := coalesce((select s.name from crm_staff s where lower(s.email) = lower(new."by") limit 1), new."by");
  if new.status = 'done' then
    txt := 'דחוף, להוציא חשבונית זיכוי בפריוריטי: ' || who || ' החזיר ₪' || to_char(new.amount, 'FM999G999G990D00')
      || ' באשראי' || coalesce(' ל' || btrim(new.payer_name), '') || ' (עסקה מקורית ' || new.tz_index || ' מ-' || to_char(new.tz_day, 'DD.MM.YY')
      || ' על ₪' || to_char(new.orig_amount, 'FM999G999G990D00') || '). סיבה: ' || btrim(new.reason)
      || '. להקליד בפריוריטי ולסמן בוצע.';
  else
    txt := 'לבדוק בטרנזילה: ' || who || ' ניסה להחזיר ₪' || to_char(new.amount, 'FM999G999G990D00')
      || ' על עסקה ' || new.tz_index || ' ולא התקבלה תשובה ברורה. לבדוק במסוף אם הזיכוי עבר, ורק אז לנסות שוב.';
  end if;
  insert into crm_tasks (tail9, text, due, "by") values (new.tail9, txt, now(), new."by") returning id into v_task;
  update crm_refunds set task_id = v_task where id = new.id;
  begin
    select hook_token into v_token from crm_push_keys where id = 1;
    perform net.http_post(
      url := 'https://ppnjosyraosrdephsksu.supabase.co/functions/v1/crm-push',
      headers := jsonb_build_object('content-type', 'application/json', 'x-hook-token', v_token),
      body := jsonb_build_object('action', 'notify', 'phone', '0' || coalesce(new.tail9, '000000000'), 'type', 'pay',
        'name', case when new.status = 'done' then '↩ הוחזרו ₪' else '⚠ זיכוי לא ברור ₪' end || to_char(new.amount, 'FM999G999G990D00') || coalesce(' · ' || btrim(new.payer_name), ''),
        'text', case when new.status = 'done' then 'זיכוי באשראי בוצע. צריך להוציא חשבונית זיכוי בפריוריטי.' else 'לבדוק בטרנזילה אם הזיכוי עבר.' end));
  exception when others then null; -- an alert problem never blocks the refund record
  end;
  return new;
end $$;
drop trigger if exists crm_refunds_task_trg on public.crm_refunds;
create trigger crm_refunds_task_trg after update of status on public.crm_refunds for each row execute function public.crm_refunds_task();
