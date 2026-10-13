-- ============================================================================
-- 006: enable Row Level Security on ALL 7 tables + drop the now-redundant dev anon
-- policies from 003. This closes the live exposure where a publishable/anon key could
-- read/write every tenant's data (incl. future Optima credentials on `business`).
--
-- ⚠️ HARD PREREQUISITE — DO THIS FIRST, OUTSIDE THIS FILE:
--   Switch SUPABASE_KEY in apps/api/.env to the SERVICE ROLE (secret) key, restart the
--   app, and confirm a WhatsApp message still gets a reply. The service role BYPASSES RLS;
--   the anon/publishable key does NOT. Running this while the app is still on the anon key
--   WILL BLOCK the app (every query denied). Order: switch key → smoke test → run 005 → run 006.
--
-- After 006: RLS is on with NO policies → all public/anon access is denied; the service-role
-- backend keeps full access. (Rollback: 006_rls_rollback.sql.)
-- ============================================================================

-- 1) Drop the dev anon policies from 003 (redundant once the backend uses the service role):
drop policy if exists conversation_anon_select on conversation;
drop policy if exists conversation_anon_insert on conversation;
drop policy if exists conversation_anon_update on conversation;
drop policy if exists message_anon_select      on message;
drop policy if exists message_anon_insert      on message;

-- 2) Enable RLS on every table (idempotent — conversation/message were already enabled by 003):
alter table business     enable row level security;
alter table service      enable row level security;
alter table staff        enable row level security;
alter table booking      enable row level security;
alter table lead         enable row level security;
alter table conversation enable row level security;
alter table message      enable row level security;
