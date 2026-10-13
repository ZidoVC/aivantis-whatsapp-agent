-- ============================================================================
-- Aivantis schema hardening (applies on top of 001_schema.sql).
--
-- Parts A–C are SAFE to run on the existing DB with data. The `add constraint`
-- statements are ONE-TIME (skip a line if that constraint already exists).
-- Part D (RLS) is a deliberate change with a hard prerequisite — read it first.
--
-- NOTE: none of this is required for the current /whatsapp flow to work; it is
-- correctness / performance / security hardening.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- A. DATA INTEGRITY
-- ---------------------------------------------------------------------------

-- One conversation row per (business, customer). Required for getConversation's
-- .eq(business_id).eq(customer_phone).maybeSingle() to be correct — without it a
-- race between two messages from a new customer creates 2 rows and maybeSingle()
-- throws. If this fails on existing duplicates, dedup first (see below).
alter table conversation alter column customer_phone set not null;
alter table conversation
  add constraint conversation_business_customer_uniq unique (business_id, customer_phone);
--   dedup helper (run only if the constraint fails):
--   delete from conversation c using conversation d
--    where c.business_id = d.business_id
--      and c.customer_phone = d.customer_phone
--      and c.id < d.id;

-- Controlled vocabularies (reject invalid values):
alter table message add constraint message_direction_chk
  check (direction in ('inbound','outbound'));
alter table booking add constraint booking_status_chk
  check (status in ('pending','confirmed','cancelled','completed','no_show'));
alter table lead add constraint lead_status_chk
  check (status in ('open','contacted','converted','closed'));

-- Money + duration sanity:
alter table service alter column price type numeric(10,2);
alter table service add constraint service_duration_chk check (duration_min > 0);
alter table service add constraint service_price_chk    check (price is null or price >= 0);


-- ---------------------------------------------------------------------------
-- B. PERFORMANCE INDEXES (idempotent)
-- ---------------------------------------------------------------------------

-- getHistory: filter by conversation_id, order by created_at.
create index if not exists idx_message_conversation_created on message(conversation_id, created_at);
-- availability / schedule queries:
create index if not exists idx_booking_business_start on booking(business_id, start_time);
create index if not exists idx_booking_staff_start    on booking(staff_id, start_time);
create index if not exists idx_lead_business_status    on lead(business_id, status);
-- (conversation(business_id, customer_phone) is already indexed by the unique in part A.)


-- ---------------------------------------------------------------------------
-- C. TRIGGERS — automatic timestamps
-- ---------------------------------------------------------------------------

-- Bump conversation.last_active on every new message.
create or replace function bump_conversation_last_active() returns trigger as $$
begin
  update conversation set last_active = now() where id = new.conversation_id;
  return new;
end; $$ language plpgsql;
drop trigger if exists trg_bump_last_active on message;
create trigger trg_bump_last_active after insert on message
  for each row execute function bump_conversation_last_active();

-- updated_at on mutable tables.
alter table business add column if not exists updated_at timestamptz default now();
alter table service  add column if not exists updated_at timestamptz default now();
alter table staff    add column if not exists updated_at timestamptz default now();
alter table booking  add column if not exists updated_at timestamptz default now();
alter table lead     add column if not exists updated_at timestamptz default now();
create or replace function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end; $$ language plpgsql;
do $$
declare t text;
begin
  foreach t in array array['business','service','staff','booking','lead'] loop
    execute format('drop trigger if exists trg_set_updated_at on %I', t);
    execute format('create trigger trg_set_updated_at before update on %I for each row execute function set_updated_at()', t);
  end loop;
end $$;


-- ---------------------------------------------------------------------------
-- D. SECURITY — Row Level Security  ⚠️ DELIBERATE CHANGE
--
-- Currently there is NO RLS: with a publishable/anon key, every tenant's data is
-- world-readable/writable.
--
-- PREREQUISITE: the backend must use the SERVICE ROLE (secret) key, NOT a
-- publishable ('sb_publishable_...') key. The service role bypasses RLS; a
-- publishable key does not. Switch SUPABASE_KEY to the secret key FIRST — enabling
-- RLS while the app uses a publishable key will BLOCK the app.
--
-- With RLS enabled and no policies: all public/anon access is denied; the
-- service-role backend keeps full access. That is the goal.
--
-- ⚠️ CREDENTIALS: before ANY Optima credential (optima_username / password / company)
-- is written into `business`, RLS on `business` MUST be enabled AND those columns
-- should be encrypted / moved to Supabase Vault — never plaintext in a table that a
-- publishable ('sb_publishable_...') key can reach.
-- ---------------------------------------------------------------------------
-- alter table business     enable row level security;
-- alter table service      enable row level security;
-- alter table staff        enable row level security;
-- alter table booking      enable row level security;
-- alter table lead         enable row level security;
-- alter table conversation enable row level security;
-- alter table message      enable row level security;
