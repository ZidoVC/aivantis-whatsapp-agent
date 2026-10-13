-- ============================================================================
-- Pre-flight check for 002_schema_hardening.sql PART A (data integrity).
-- Run this in the Supabase SQL editor BEFORE applying Part A. Every count must be 0.
-- If any row shows offending > 0, fix those rows first (see the detail queries at the
-- bottom) — otherwise the matching ALTER ... ADD CONSTRAINT / SET NOT NULL in Part A
-- will fail. Read-only: this script only SELECTs, it changes nothing.
-- ============================================================================

select 'conversation.customer_phone IS NULL'                    as check_name,
       count(*)                                                 as offending
  from conversation
 where customer_phone is null
union all
select 'conversation duplicate (business_id, customer_phone)',
       coalesce(sum(cnt - 1), 0)
  from (select business_id, customer_phone, count(*) as cnt
          from conversation
         group by business_id, customer_phone
        having count(*) > 1) d
union all
select 'message.direction not in (inbound,outbound)',
       count(*)
  from message
 where direction not in ('inbound', 'outbound')
union all
select 'booking.status invalid',
       count(*)
  from booking
 where status not in ('pending', 'confirmed', 'cancelled', 'completed', 'no_show')
union all
select 'lead.status invalid',
       count(*)
  from lead
 where status not in ('open', 'contacted', 'converted', 'closed')
union all
select 'service.duration_min <= 0',
       count(*)
  from service
 where duration_min <= 0
union all
select 'service.price < 0',
       count(*)
  from service
 where price < 0
union all
select 'service.price loses precision at numeric(10,2)',
       count(*)
  from service
 where price is not null and price <> round(price, 2)
 order by offending desc, check_name;

-- ---- detail queries (uncomment to inspect the offending rows) ----
-- select * from conversation where customer_phone is null;
-- select business_id, customer_phone, count(*)
--   from conversation group by business_id, customer_phone having count(*) > 1;
-- select id, direction from message where direction not in ('inbound','outbound');
-- select id, status from booking
--   where status not in ('pending','confirmed','cancelled','completed','no_show');
-- select id, status from lead where status not in ('open','contacted','converted','closed');
-- select id, duration_min, price from service where duration_min <= 0 or price < 0;
