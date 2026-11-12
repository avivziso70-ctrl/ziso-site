-- 12.11.2026: a Tranzila notify that could not be confirmed on the spot is checked again every minute for 24 hours
-- (crm-pay-notify, action "recheck"). The function is called only while such a notify is waiting.
select cron.schedule('crm-pay-recheck', '* * * * *', $cron$
  select net.http_post(
    url := 'https://ppnjosyraosrdephsksu.supabase.co/functions/v1/crm-pay-notify',
    headers := jsonb_build_object('content-type', 'application/json', 'x-hook-token', (select hook_token from public.crm_push_keys where id = 1)),
    body := jsonb_build_object('action', 'recheck'))
  where exists (
    select 1 from public.crm_audit a join public.crm_pay_requests p on p.id = (a.detail->>'id')::bigint
    where a.action = 'pay_notify_unverified' and a.at > now() - interval '24 hours' and a.detail ? 'code' and p.status <> 'paid')
$cron$);
