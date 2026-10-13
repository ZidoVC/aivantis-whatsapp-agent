-- ============================================================================
-- DEV RLS policies — allow the anon/publishable key to run the WhatsApp memory
-- flow (conversation + message), SCOPED to the single dev business.
--
-- Not "open to the world": every policy is conditioned on the dev business id.
-- Touches ONLY conversation and message. Re-runnable (drop-if-exists first).
--
-- Prod note: the correct long-term setup is a SERVICE ROLE key server-side (which
-- bypasses RLS); then these anon policies become irrelevant. See 002 §D.
-- ============================================================================

-- The dev business (Demo Clinic) — must equal DEFAULT_BUSINESS_ID in apps/api/.env.
-- Update this if you add more businesses / move to auth-based scoping.

-- ---------------------------- conversation --------------------------------
alter table conversation enable row level security;

drop policy if exists conversation_anon_select on conversation;
create policy conversation_anon_select on conversation
  for select to anon
  using (business_id = '11111111-1111-4111-8111-111111111111');

drop policy if exists conversation_anon_insert on conversation;
create policy conversation_anon_insert on conversation
  for insert to anon
  with check (business_id = '11111111-1111-4111-8111-111111111111');

-- UPDATE so the (optional) last_active trigger from 002 works under RLS.
drop policy if exists conversation_anon_update on conversation;
create policy conversation_anon_update on conversation
  for update to anon
  using (business_id = '11111111-1111-4111-8111-111111111111')
  with check (business_id = '11111111-1111-4111-8111-111111111111');

-- ------------------------------- message ----------------------------------
alter table message enable row level security;

-- message has no business_id; scope via its parent conversation.
drop policy if exists message_anon_select on message;
create policy message_anon_select on message
  for select to anon
  using (exists (
    select 1 from conversation c
    where c.id = message.conversation_id
      and c.business_id = '11111111-1111-4111-8111-111111111111'
  ));

drop policy if exists message_anon_insert on message;
create policy message_anon_insert on message
  for insert to anon
  with check (exists (
    select 1 from conversation c
    where c.id = conversation_id
      and c.business_id = '11111111-1111-4111-8111-111111111111'
  ));

-- ------------------------------- business ---------------------------------
-- OPTIONAL — enable ONLY when the app actually reads from `business`.
-- ⚠️ `business` will later hold optima_* credentials; do NOT expose those to anon.
-- Prefer switching the backend to a service-role key before reading business.
-- alter table business enable row level security;
-- drop policy if exists business_anon_select on business;
-- create policy business_anon_select on business
--   for select to anon
--   using (id = '11111111-1111-4111-8111-111111111111');
