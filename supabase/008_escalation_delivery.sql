-- ============================================================================
-- 008: durable record of escalations whose STAFF NOTIFICATION could not be delivered.
--
-- WHY: the escalation staff-notification channel (Twilio WhatsApp) is failure-safe — if a
-- send fails (Twilio down/misconfigured, no phone), the customer still gets "the team will
-- get back to you", but nobody was actually alerted. A silent miss on a medical complaint is
-- the one failure we cannot have. On [escalation-notify-failed] the app writes a row here so
-- we can query the escalations that were never delivered:
--
--   select * from escalation_delivery where delivered = false order by created_at desc;
--
-- The app degrades gracefully if this table is missing (recordEscalationDelivery logs LOUDLY
-- under [escalation-notify-failed] instead of crashing) — so running this migration is SAFE at
-- any time and the app never breaks for lack of it. Idempotent. SAFE to run on the live DB.
--
-- RLS is enabled with NO policies (consistent with 006): the service-role backend writes/reads
-- it; anon/publishable access is denied. Rollback: `drop table if exists escalation_delivery;`
-- ============================================================================

create table if not exists escalation_delivery (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business(id) on delete cascade,
  conversation_id uuid references conversation(id) on delete set null,
  category text not null,                 -- the EscalationCategory (e.g. medical_symptom)
  customer_phone text,
  reason text,                            -- no_phone | sender_not_configured | send_error
  delivered boolean not null default false,
  created_at timestamptz default now()
);

create index if not exists idx_escalation_delivery_business on escalation_delivery(business_id);
-- Fast lookup of the ones that still need a human to chase:
create index if not exists idx_escalation_delivery_undelivered
  on escalation_delivery(business_id, created_at)
  where delivered = false;

alter table escalation_delivery enable row level security;
