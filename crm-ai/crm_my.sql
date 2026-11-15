-- The customer's live page (zisoceramics.com/my/#<token>), phase 2 of the deal flow.
-- Aviv 15.11.2026: "ללקוח לינק לדף אינטרקטיבי, חי, עם כל פרטי העסקה שלו".
-- The page is public and has no login: it talks only to the two functions at the bottom.
--   the link carries a 144-bit secret (crm_deals.share_token), and the customer types the last 4 digits of the phone once;
--   5 wrong tries lock the link for 15 minutes; nothing personal is returned before the digits match;
--   never returned: cost, profit, supplier names, purchase order numbers, staff emails.
-- No DROP in this file (a destructive statement makes the Supabase tool wait for a confirmation nobody sees).

alter table public.crm_deals
  add column if not exists cust_no text,                       -- Priority customer number, when the customer was picked from a card that has one
  add column if not exists share_token text,                   -- the secret of the customer's link; null = not shared
  add column if not exists shared_at timestamptz,
  add column if not exists shared_by text,
  add column if not exists seen_at timestamptz,                -- last time the customer opened the page
  add column if not exists seen_count int not null default 0,
  add column if not exists public_note text;                   -- the team's message at the top of the customer's page
create unique index if not exists crm_deals_share_idx on public.crm_deals (share_token) where share_token is not null;

-- What the customer writes on the page, and what the team answers there.
create table if not exists public.crm_deal_notes (
  id bigint generated always as identity primary key,
  deal_id bigint not null references public.crm_deals (id),
  side text not null check (side in ('customer', 'team')),
  kind text,                                                   -- customer: question | change | delivery | problem
  text text not null check (length(text) between 1 and 2000),
  "by" text, by_name text,                                     -- staff, for side = team
  task_id bigint,
  at timestamptz not null default now()
);
create index if not exists crm_deal_notes_deal_idx on public.crm_deal_notes (deal_id, at);
alter table public.crm_deal_notes enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'crm_deal_notes' and policyname = 'staff read') then
    create policy "staff read" on public.crm_deal_notes for select using (public.crm_me() is not null);
    create policy "staff answer" on public.crm_deal_notes for insert with check (public.crm_me() is not null and side = 'team');
  end if;
end $$;

-- Wrong digits, per link. No policy: only the functions below touch it.
create table if not exists public.crm_my_tries (
  id bigint generated always as identity primary key,
  token_md5 text not null,
  at timestamptz not null default now()
);
create index if not exists crm_my_tries_idx on public.crm_my_tries (token_md5, at);
alter table public.crm_my_tries enable row level security;

-- The gate: which deal does this link + digits open? err: not_found | pin | pin_wrong | locked.
create or replace function public.crm_my_gate(p_token text, p_pin text, out deal_id bigint, out err text, out tries_left int)
language plpgsql security definer set search_path to 'public' as $$
declare d crm_deals; h text; n int;
begin
  if p_token is null or length(p_token) < 20 or length(p_token) > 64 then err := 'not_found'; return; end if;
  select * into d from crm_deals where share_token = p_token;
  if d.id is null or d.customer_tail9 is null or length(d.customer_tail9) < 4 then err := 'not_found'; return; end if;
  h := md5(p_token);
  select count(*) into n from crm_my_tries where token_md5 = h and at > now() - interval '15 minutes';
  if n >= 5 then err := 'locked'; return; end if;
  if coalesce(p_pin, '') = '' then err := 'pin'; return; end if;
  if regexp_replace(p_pin, '\D', '', 'g') is distinct from right(d.customer_tail9, 4) then
    insert into crm_my_tries (token_md5) values (h);
    err := case when n + 1 >= 5 then 'locked' else 'pin_wrong' end; tries_left := greatest(0, 4 - n); return;
  end if;
  deal_id := d.id;
end $$;

-- Everything the customer's page shows, in one answer.
create or replace function public.crm_my(p_token text, p_pin text default null) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare g record; d crm_deals; v_cust text; v_lines jsonb; v_money jsonb := '{}'::jsonb; v_bal numeric;
begin
  select * into g from crm_my_gate(p_token, p_pin);
  if g.err is not null then return jsonb_build_object('ok', false, 'error', g.err, 'tries_left', g.tries_left); end if;
  select * into d from crm_deals where id = g.deal_id;
  if d.seen_at is null or d.seen_at < now() - interval '10 minutes' then
    update crm_deals set seen_at = now(), seen_count = seen_count + 1 where id = d.id;
  end if;

  -- products: stage per line, from the purchase order behind it. Nothing about the supplier or the cost.
  select coalesce(jsonb_agg(jsonb_build_object(
      'desc', l.j ->> 'desc', 'size', l.j ->> 'size', 'unit', l.j ->> 'unit',
      'qty', (l.j ->> 'qty')::numeric, 'sell', (l.j ->> 'sell')::numeric,
      'stage', case
        when l.j ->> 'delivered_at' is not null then 'delivered'
        when coalesce((l.j ->> 'stock')::boolean, false) then 'ready'
        when p.id is null or p.status in ('failed', 'cancelled') then 'chosen'
        when p.received_at is not null and p.receive_state = 'full' then 'ready'
        when p.received_at is not null then 'partial'
        when p.status = 'confirmed' then 'confirmed'
        else 'ordered' end,
      'ordered_at', case when p.status not in ('failed', 'cancelled') then coalesce(p.sent_at, p.created_at) end,
      'confirmed_at', case when p.status = 'confirmed' then p.confirmed_at end,
      'arrived_at', p.received_at,
      'delivered_at', l.j ->> 'delivered_at',
      -- expected arrival: what the team typed, else the median of this supplier's real deliveries (3 orders or more)
      'eta', coalesce(l.j ->> 'eta', case when p.id is not null and p.received_at is null and p.status in ('sent', 'confirmed') and lt.orders >= 3
        then to_char((coalesce(p.sent_at, p.created_at) + make_interval(days => ceil(lt.median_days)::int)) at time zone 'Asia/Jerusalem', 'YYYY-MM-DD') end),
      'eta_from', case when l.j ->> 'eta' is not null then 'team' when lt.orders >= 3 then 'stats' end
    ) order by l.n), '[]'::jsonb) into v_lines
  from jsonb_array_elements(coalesce(d.lines, '[]'::jsonb)) with ordinality l(j, n)
  left join crm_po p on p.id = nullif(l.j ->> 'po_id', '')::bigint and p.deal_id = d.id
  left join crm_po_lead_times lt on lt.supplier_id::text = p.supplier_id::text;

  -- the account in Priority, only when the customer is identified without doubt
  v_cust := coalesce(d.cust_no,
    (select c.priority_cust_no from crm_customers c where c.tail9 = d.customer_tail9 and c.deleted_at is null and c.priority_cust_no is not null limit 1),
    (select min(pc.cust_no) from priority_customers pc where pc.tail9 = d.customer_tail9 having count(*) = 1));
  if v_cust is not null then
    select a.total into v_bal from priority_aging a where a.cust_no = v_cust limit 1;
    v_money := jsonb_build_object(
      'known', true, 'balance', coalesce(v_bal, 0),
      'as_of', (select source_at from priority_sync where key = 'aging'),
      'invoices', (select coalesce(jsonb_agg(x order by x.date desc), '[]'::jsonb) from (select i.doc, i.date, i.amount from priority_invoices i where i.cust_no = v_cust and i.date >= current_date - 400 order by i.date desc limit 30) x),
      'receipts', (select coalesce(jsonb_agg(x order by x.date desc), '[]'::jsonb) from (select r.doc, r.date, r.amount, r.method from priority_receipts r where r.cust_no = v_cust and r.date >= current_date - 400 order by r.date desc limit 30) x));
  end if;
  v_money := v_money || jsonb_build_object(
    'to_pay', (select coalesce(jsonb_agg(jsonb_build_object('amount', q.amount, 'what', q.description, 'link', q.pr_link) order by q.id desc), '[]'::jsonb)
      from crm_pay_requests q where q.tail9 = d.customer_tail9 and q.status = 'created' and not coalesce(q.test, false) and q.pr_link is not null and q.created_at > now() - interval '30 days'),
    'paid', (select coalesce(jsonb_agg(jsonb_build_object('amount', coalesce(q.paid_sum, q.amount), 'what', q.description, 'at', q.paid_at) order by q.paid_at desc), '[]'::jsonb)
      from crm_pay_requests q where q.tail9 = d.customer_tail9 and q.status = 'paid' and not coalesce(q.test, false) and q.paid_at > now() - interval '180 days'));

  return jsonb_build_object('ok', true, 'now', now(),
    'deal', jsonb_build_object('no', d.deal_no, 'name', d.customer_name, 'status', d.status, 'created_at', d.created_at, 'updated_at', d.updated_at,
      'total', d.total_sell, 'note', d.public_note, 'deliver_to', coalesce(d.deliver_to, 'business'),
      'address', case when d.deliver_to = 'customer' then d.deliver ->> 'address' end),
    'lines', v_lines, 'money', v_money,
    'notes', (select coalesce(jsonb_agg(jsonb_build_object('side', n.side, 'kind', n.kind, 'text', n.text, 'by', case when n.side = 'team' then n.by_name end, 'at', n.at) order by n.at), '[]'::jsonb)
      from (select * from crm_deal_notes where deal_id = d.id order by at desc limit 60) n));
end $$;

-- The customer writes to the team: kept on the deal, a task for the team, a push to the phones.
create or replace function public.crm_my_note(p_token text, p_pin text, p_kind text, p_text text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare g record; d crm_deals; v_text text := btrim(coalesce(p_text, '')); v_task bigint;
  v_kind text := case when p_kind in ('question', 'change', 'delivery', 'problem') then p_kind else 'question' end;
  v_label text;
begin
  select * into g from crm_my_gate(p_token, p_pin);
  if g.err is not null then return jsonb_build_object('ok', false, 'error', g.err); end if;
  if length(v_text) < 2 or length(v_text) > 1000 then return jsonb_build_object('ok', false, 'error', 'text'); end if;
  if (select count(*) from crm_deal_notes where deal_id = g.deal_id and side = 'customer' and at > now() - interval '24 hours') >= 10 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;
  select * into d from crm_deals where id = g.deal_id;
  v_label := case v_kind when 'change' then 'בקשת שינוי' when 'delivery' then 'תיאום אספקה' when 'problem' then 'בעיה במוצר' else 'שאלה' end;
  insert into crm_tasks (tail9, text, due, "by") values (d.customer_tail9,
    v_label || ' מדף הלקוח · ' || d.deal_no || ' · ' || coalesce(d.customer_name, '') || ': ' || v_text || ' (עונים מתיק העסקה, התשובה מופיעה ללקוח בדף.)',
    now(), 'דף לקוח') returning id into v_task;
  insert into crm_deal_notes (deal_id, side, kind, text, task_id) values (d.id, 'customer', v_kind, v_text, v_task);
  perform crm_po_push('💬 ' || v_label || ' · ' || coalesce(d.customer_name, d.deal_no), left(v_text, 140));
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.crm_my_gate(text, text) from public, anon, authenticated;
grant execute on function public.crm_my(text, text) to anon, authenticated;
grant execute on function public.crm_my_note(text, text, text, text) to anon, authenticated;
