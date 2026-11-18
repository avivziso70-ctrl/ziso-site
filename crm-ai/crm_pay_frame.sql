-- Payment inside our own pages (Aviv 18.11.2026). Every payment request gets a token that the customer's page, the WhatsApp
-- link, the till and the store use to show Tranzila's iframe for that request (crm-pay actions pay_info / pay_state) and
-- that comes back in Tranzila's notify (crm-pay-notify, zpay + zk). paid_code keeps the confirmation code of the charge so
-- one payment can never confirm two requests. payments = the most instalments the customer may choose. No DROP in this file.
alter table public.crm_pay_requests add column if not exists pay_token uuid not null default gen_random_uuid();
create unique index if not exists crm_pay_requests_token_uq on public.crm_pay_requests (pay_token);
alter table public.crm_pay_requests add column if not exists paid_code text;
alter table public.crm_pay_requests add column if not exists payments int not null default 1;
