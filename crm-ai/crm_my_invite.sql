-- Sending the WhatsApp invite to a new customer's page (edge function crm-my-invite, template ziso_my_page).
-- Aviv 17.11 approved the wording unchanged; submit to Meta, test on a test number, only then send to new customers.
-- my_invites_on stays false until the template is approved AND the test message reached the test number (Aviv's own
-- phone, taken from wa_family in the DB, never written in the repo). Until then only the invite marked note='test' goes out.
-- No DROP in this file.
alter table public.crm_settings add column if not exists my_invites_on boolean not null default false;

-- the test: a page for Aviv himself (his phone from wa_family), with one invite marked 'test'
do $$ declare v_tail text; v_deal bigint; begin
  select right(regexp_replace(phone, '\D', '', 'g'), 9) into v_tail from public.wa_family where name = 'אביב' limit 1;
  if v_tail is null or exists (select 1 from public.crm_my_invites where note = 'test') then return; end if;
  insert into public.crm_deals (customer_name, customer_tail9, deliver_to, deliver, lines, markup, status, total_sell, "by", by_name, share_token, shared_at, shared_by)
  values ('אביב (בדיקה)', v_tail, 'business', '{}'::jsonb, '[]'::jsonb, 0, 'open', 0, 'auto', 'אוטומטי',
          translate(encode(extensions.gen_random_bytes(18), 'base64'), '+/', '-_'), now(), 'auto: invite test')
  returning id into v_deal;
  insert into public.crm_my_invites (deal_id, tail9, status, note) values (v_deal, v_tail, 'queued', 'test');
end $$;

select cron.schedule('crm-my-invite', '*/10 * * * *',
  $c$select net.http_post(url := 'https://ppnjosyraosrdephsksu.supabase.co/functions/v1/crm-my-invite', body := '{}'::jsonb, timeout_milliseconds := 30000)$c$);
