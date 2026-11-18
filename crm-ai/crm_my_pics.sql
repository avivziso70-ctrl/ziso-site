-- Catalog pictures for the customer's page (Aviv 17.11: "וגם את התמונה של הפריט אם יש"). Entry: edge function crm-my-pics
-- (service role) signs one-hour links on the private bucket supplier-files. Only lines that came from a price list (price_id)
-- with sp_prices.image_path have a picture. Photos that came from a chat with a supplier (upload source chat-extract)
-- are examples of another order, so staff see them and the customer's page does not. No DROP in this file.
create or replace function public.crm_my_pics(p_token text, p_pin text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare g record; v jsonb;
begin
  select * into g from crm_my_gate(p_token, p_pin);
  if g.err is not null then return jsonb_build_object('ok', false, 'error', g.err); end if;
  select coalesce(jsonb_agg(jsonb_build_object('i', l.n - 1, 'path', p.image_path)), '[]'::jsonb) into v
  from crm_deals d, jsonb_array_elements(coalesce(d.lines, '[]'::jsonb)) with ordinality l(j, n)
  join sp_prices p on p.id::text = l.j ->> 'price_id' and p.image_path is not null
  where d.id = g.deal_id
    and not exists (select 1 from sp_uploads u where u.id = p.upload_id and u.source = 'chat-extract');
  return jsonb_build_object('ok', true, 'pics', v);
end $$;
revoke all on function public.crm_my_pics(text, text) from public, anon, authenticated;
