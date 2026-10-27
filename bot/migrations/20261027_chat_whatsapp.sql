-- WhatsApp conversations are keyed by the sender's number (local format), one session per number per 24h.
alter table public.chat_sessions add column if not exists contact text;
create index if not exists chat_sessions_contact_idx on public.chat_sessions (channel, contact, updated_at desc);
