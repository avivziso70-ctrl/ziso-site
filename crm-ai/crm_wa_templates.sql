-- Where our supplier WhatsApp templates stand at Meta, read only. Posts to crm-po (action wa_templates) with the hook
-- token, which is read here and never shown. The answer lands in net._http_response under the returned id.
-- Service role only. No DROP in this file.
create or replace function public.crm_wa_templates() returns bigint language plpgsql security definer set search_path to 'public' as $$
declare v_token text; v_id bigint;
begin
  select hook_token into v_token from crm_push_keys where id = 1;
  select net.http_post(
    url := 'https://ppnjosyraosrdephsksu.supabase.co/functions/v1/crm-po',
    headers := jsonb_build_object('content-type', 'application/json', 'x-hook-token', v_token),
    body := jsonb_build_object('action', 'wa_templates')) into v_id;
  return v_id;
end $$;
revoke all on function public.crm_wa_templates() from public, anon, authenticated;
