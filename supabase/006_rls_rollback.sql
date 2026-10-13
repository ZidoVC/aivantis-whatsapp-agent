-- ============================================================================
-- ROLLBACK for 006 — restores the pre-part-D state (dev anon access on conversation +
-- message; RLS off on the rest). Use if the app breaks after 006 (usually: the service-role
-- key wasn't switched). NOTE: if the app is already on the service-role key it keeps working
-- regardless — you only need this to let the ANON key back in.
-- ============================================================================

-- Turn RLS back off on the tables that had no policies (003 never managed these):
alter table business disable row level security;
alter table service  disable row level security;
alter table staff    disable row level security;
alter table booking  disable row level security;
alter table lead     disable row level security;

-- Restore the dev anon policies on conversation + message (verbatim from 003), so the
-- publishable/anon key can run the WhatsApp memory flow again:
create policy conversation_anon_select on conversation for select to anon
  using (business_id = '11111111-1111-4111-8111-111111111111');
create policy conversation_anon_insert on conversation for insert to anon
  with check (business_id = '11111111-1111-4111-8111-111111111111');
create policy conversation_anon_update on conversation for update to anon
  using (business_id = '11111111-1111-4111-8111-111111111111')
  with check (business_id = '11111111-1111-4111-8111-111111111111');
create policy message_anon_select on message for select to anon
  using (exists (select 1 from conversation c
                  where c.id = message.conversation_id
                    and c.business_id = '11111111-1111-4111-8111-111111111111'));
create policy message_anon_insert on message for insert to anon
  with check (exists (select 1 from conversation c
                       where c.id = conversation_id
                         and c.business_id = '11111111-1111-4111-8111-111111111111'));

-- To also undo 005 (the lead unique constraint), if needed:
--   alter table lead drop constraint if exists lead_business_customer_uniq;
