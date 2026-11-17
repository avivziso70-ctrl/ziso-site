-- Print from "תשאלו את קלוד" (Aviv 17.11.2026): "שאיש צוות יוכל לבקש. תדפיס לי את הקבלה של.. את החשבונית.. ושזה פשוט ידפיס".
-- Target is always the main office printer: Canon LBP214 on the office network (10.0.0.3).
-- A staff request (crm-ask tool print_document, staff JWT, the document must exist in Priority) becomes a priority_jobs row
-- 'print_document' with print_to = 'canon'. The office robot (משרד 2, same network, SumatraPDF already there) makes the PDF from
-- Priority as it does for receipt copies, then prints it on the Canon. The job's result flows back to crm_print_requests.
-- Receipts and invoices only for now (what the robot can open). Every request keeps who asked and when. Staff only. No DROP.

create table if not exists public.crm_print_requests (
  id bigint generated always as identity primary key,
  doc text not null,
  kind text not null check (kind in ('receipt', 'invoice')),
  cust_name text,
  amount numeric,
  doc_date date,
  copies int not null default 1 check (copies between 1 and 3),
  printer text not null default 'canon',
  requested_by text not null,
  requested_at timestamptz not null default now(),
  status text not null default 'queued' check (status in ('queued', 'printing', 'printed', 'failed', 'cancelled')),
  job_id uuid,
  note text,
  printed_at timestamptz
);
create index if not exists crm_print_requests_at_idx on public.crm_print_requests (requested_at desc);
alter table public.crm_print_requests enable row level security;
create policy crm_print_requests_staff on public.crm_print_requests for select using (public.crm_me() is not null);

create or replace function public.crm_print_enqueue() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare j uuid;
begin
  if new.status <> 'queued' then return new; end if;
  insert into public.priority_jobs (type, params, requested_by, priority, idempotency_key)
  values ('print_document',
          jsonb_build_object('doc', new.doc, 'kind', new.kind, 'print_to', new.printer, 'copies', new.copies, 'allow_original', true, 'print_request_id', new.id),
          'crm-print:' || new.requested_by, 2, 'crm_print:' || new.id)
  returning id into j;
  new.job_id := j;
  return new;
end $$;
create trigger crm_print_requests_enqueue before insert on public.crm_print_requests for each row execute function public.crm_print_enqueue();

-- the robot's job status flows back: running = printing, done = printed, failed / blocked / cancelled = failed with the robot's note
create or replace function public.crm_print_from_job() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if new.type <> 'print_document' or new.idempotency_key not like 'crm_print:%' or new.status is not distinct from old.status then return new; end if;
  update public.crm_print_requests set
    status = case new.status when 'running' then 'printing' when 'done' then 'printed' when 'queued' then 'queued' else 'failed' end,
    printed_at = case when new.status = 'done' then coalesce(new.finished_at, now()) else printed_at end,
    note = case when new.status in ('failed', 'blocked', 'cancelled') then left(coalesce(new.last_note, new.error, new.status), 300) else note end
  where job_id = new.id;
  return new;
end $$;
create trigger priority_jobs_print_status after update of status on public.priority_jobs for each row execute function public.crm_print_from_job();
-- Off until the robot prints for real: crm_settings.print_on (default false). Turned on after the first verified test print.
alter table public.crm_settings add column if not exists print_on boolean not null default false;
