-- ============================================================================
-- 005: unique(business_id, customer_phone) on `lead` — enables safe dedup/upsert of
-- leads (Issue 2). Independent of the RLS change; can run before or after 006.
--
-- Pre-flight (run first — expect 0 rows). If it returns rows, dedup before the ALTER:
--   select business_id, customer_phone, count(*)
--     from lead
--    group by business_id, customer_phone
--   having count(*) > 1;
--
-- Dedup helper (run ONLY if the pre-flight returned rows — keeps the earliest lead per phone):
--   delete from lead a using lead b
--    where a.business_id = b.business_id
--      and a.customer_phone = b.customer_phone
--      and a.created_at > b.created_at;
-- ============================================================================

alter table lead
  add constraint lead_business_customer_uniq unique (business_id, customer_phone);
