-- Payment inside our own pages (Aviv 18.11.2026). Every payment request gets a token that the customer's page, the WhatsApp
-- link, the till and the store use to show Tranzila's iframe for that request (crm-pay actions pay_info / pay_state) and
-- that comes back in Tranzila's notify (crm-pay-notify, zpay + zk). paid_code keeps the confirmation code of the charge so
-- one payment can never confirm two requests. payments = the most instalments the customer may choose. No DROP in this file.
alter table public.crm_pay_requests add column if not exists pay_token uuid not null default gen_random_uuid();
create unique index if not exists crm_pay_requests_token_uq on public.crm_pay_requests (pay_token);
alter table public.crm_pay_requests add column if not exists paid_code text;
alter table public.crm_pay_requests add column if not exists payments int not null default 1;

-- The switch for in-page payment on the CRM side (customer page, /pay/ page, till, customer card). Off until one real
-- payment through the frame was confirmed by crm-pay-notify. While off, everything keeps using Tranzila's link.
-- crm_my (crm_my_priority.sql) gives the pay token of each open request only when it is on.
alter table crm_settings add column if not exists pay_frame_on boolean not null default false;
-- 18.11.2026 09:06Z: first real payment through the frame confirmed (request 19, audit pay_paid via 'frame'), so the
-- switch was turned on by hand: update crm_settings set pay_frame_on = true where id = 1.
-- Requests with instalments (payments > 1) still get Tranzila's link: crm_my and crm-pay give the token / page link
-- only for a single payment, until the frame's instalment mode was seen working.
