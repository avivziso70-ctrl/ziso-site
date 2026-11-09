create table if not exists public.crm_ai (tail9 text primary key, temp text, score int, intent text, stage_guess text, next_action text, next_due date, risk text, reason text, summary text, src_ts timestamptz, model text, at timestamptz not null default now(), done_at timestamptz, done_by text);
alter table public.crm_ai enable row level security;
drop policy if exists crm_ai_read on public.crm_ai;
create policy crm_ai_read on public.crm_ai for select using (crm_me() is not null);
drop policy if exists crm_ai_done on public.crm_ai;
create policy crm_ai_done on public.crm_ai for update using (crm_me() is not null) with check (crm_me() is not null);
revoke all on public.crm_ai from anon, authenticated;
grant select on public.crm_ai to authenticated;
grant update (done_at, done_by) on public.crm_ai to authenticated;
create table if not exists public.crm_ai_settings (id int primary key default 1 check (id = 1), enabled boolean not null default false, daily_cap int not null default 60, updated_at timestamptz default now(), updated_by text);
insert into public.crm_ai_settings (id) values (1) on conflict do nothing;
alter table public.crm_ai_settings enable row level security;
revoke all on public.crm_ai_settings from anon, authenticated;
create or replace function public.crm_ai_candidates(p_limit int default 25)
returns table (tail9 text, src_ts timestamptz)
language sql security definer set search_path = public as $f$
  with staff as (select right(regexp_replace(x, $r$\D$r$, $e$$e$, $g$g$g$), 9) t9 from wa_config, unnest(no_bot_phones) x),
  act as (
    select right(regexp_replace(phone, $r$\D$r$, $e$$e$, $g$g$g$), 9) t9, max(ts) ts from wa_messages
     where ts > now() - interval $i$21 days$i$ and source in ($s$live$s$, $s$bot$s$, $s$phone-app$s$, $s$crm$s$) group by 1
    union all
    select phone_tail9, max(greatest(created_at, coalesce(updated_at, created_at))) from leads
     where length(phone_tail9) = 9 and created_at > now() - interval $i$21 days$i$ group by 1
    union all
    select tail9, max(at) from crm_notes where deleted_at is null and at > now() - interval $i$21 days$i$ group by 1),
  live as (
    select right(regexp_replace(phone, $r$\D$r$, $e$$e$, $g$g$g$), 9) t9 from wa_messages
     where dir = $d$in$d$ and source = $s$live$s$ and ts > now() - interval $i$21 days$i$
    union select phone_tail9 from leads where created_at > now() - interval $i$21 days$i$),
  a as (select act.t9, max(act.ts) ts from act join live on live.t9 = act.t9 group by 1)
  select a.t9, a.ts from a
   left join crm_ai x on x.tail9 = a.t9
   left join crm_customers k on k.tail9 = a.t9
  where a.t9 not in (select t9 from staff)
    and coalesce(k.kind, $e$$e$) not in ($k$supplier$k$, $k$not_customer$k$)
    and (x.src_ts is null or a.ts > x.src_ts)
  order by a.ts desc limit p_limit
$f$;
revoke all on function public.crm_ai_candidates(int) from public, anon, authenticated;
select cron.schedule($j$crm-ai-triage$j$, $c$7 6-16 * * 0-5$c$, $q$select net.http_post(url := $u$https://ppnjosyraosrdephsksu.supabase.co/functions/v1/crm-ai-triage$u$, headers := jsonb_build_object($h$content-type$h$, $h$application/json$h$, $h$x-hook-token$h$, (select hook_token from public.crm_push_keys where id = 1)), body := $b${}$b$::jsonb, timeout_milliseconds := 150000)$q$);
