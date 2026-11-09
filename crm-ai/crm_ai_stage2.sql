create table if not exists public.crm_quote_fu (pq text primary key, tail9 text, cust_no text, draft text, angle text, at timestamptz not null default now(), model text, status text not null default $s$open$s$, status_at timestamptz, status_by text);
alter table public.crm_quote_fu enable row level security;
drop policy if exists crm_quote_fu_read on public.crm_quote_fu;
create policy crm_quote_fu_read on public.crm_quote_fu for select using (crm_me() is not null);
drop policy if exists crm_quote_fu_upd on public.crm_quote_fu;
create policy crm_quote_fu_upd on public.crm_quote_fu for update using (crm_me() is not null) with check (crm_me() is not null);
revoke all on public.crm_quote_fu from anon, authenticated;
grant select on public.crm_quote_fu to authenticated;
grant update (status, status_at, status_by) on public.crm_quote_fu to authenticated;
create table if not exists public.crm_insights (id bigint generated always as identity primary key, period_start date, period_end date, body text, stats jsonb, model text, at timestamptz not null default now());
alter table public.crm_insights enable row level security;
drop policy if exists crm_insights_owner on public.crm_insights;
create policy crm_insights_owner on public.crm_insights for select using (crm_is_owner());
revoke all on public.crm_insights from anon, authenticated;
grant select on public.crm_insights to authenticated;
create or replace function public.crm_stalled_quotes()
returns table (pq text, cust_no text, name text, tail9 text, date date, total numeric, days int, status text, draft text, angle text, fu_status text, temp text, next_action text)
language sql stable security definer set search_path = public as $f$
  select q.pq, q.cust_no, coalesce(k.name, q.cust_name), c.tail9, q.date, q.total, (current_date - q.date)::int, q.status,
         f.draft, f.angle, coalesce(f.status, $o$open$o$), a.temp, a.next_action
    from priority_quotes q
    left join priority_customers c on c.cust_no = q.cust_no
    left join crm_customers k on k.tail9 = c.tail9 and k.deleted_at is null
    left join crm_quote_fu f on f.pq = q.pq
    left join crm_ai a on a.tail9 = c.tail9
   where (crm_me() is not null or auth.role() = $r$service_role$r$)
     and q.active and q.total > 0 and q.cust_no <> $w$1000001$w$
     and q.date between current_date - 30 and current_date - 3
     and coalesce(k.kind, $e$$e$) not in ($k$supplier$k$, $k$not_customer$k$)
     and not exists (select 1 from priority_orders_all o where o.cust_no = q.cust_no and o.date >= q.date)
     and not exists (select 1 from priority_quotes q2 where q2.cust_no = q.cust_no and q2.active and q2.date > q.date)
     and coalesce(f.status, $o$open$o$) = $o$open$o$
   order by q.total desc
$f$;
revoke all on function public.crm_stalled_quotes() from public, anon;
grant execute on function public.crm_stalled_quotes() to authenticated, service_role;
select cron.schedule($j$crm-ai-weekly$j$, $c$0 4 * * 0$c$, $q$select net.http_post(url := $u$https://ppnjosyraosrdephsksu.supabase.co/functions/v1/crm-ai-triage$u$, headers := jsonb_build_object($h$content-type$h$, $h$application/json$h$, $h$x-hook-token$h$, (select hook_token from public.crm_push_keys where id = 1)), body := $b${"mode":"weekly"}$b$::jsonb, timeout_milliseconds := 150000)$q$);
