-- ============================================================================
-- 004: pending-action state (Issue 1) + durable tool-call log (observability).
--
-- Both columns are jsonb and NULLABLE. The app code is written defensively: if
-- these columns do not exist yet, the code degrades silently (the message still
-- saves and the reply is still sent) — so running this migration is SAFE at any
-- time and the app never breaks for lack of it. The features only "light up"
-- once these columns exist.
-- Idempotent (add column if not exists). SAFE to run on the live DB with data.
-- ============================================================================

alter table conversation add column if not exists pending_action jsonb;
alter table message      add column if not exists tool_log       jsonb;

comment on column conversation.pending_action is
  'A booking change (reschedule / cancel) that was escalated to staff but NOT executed. '
  'Injected into the next agent turn so the agent never claims the change is already done. '
  'Shape: {type, detail, at}. Cleared when a new booking is created or a new pending action replaces it.';

comment on column message.tool_log is
  'Durable audit of the tool calls made in the turn that produced this (outbound) message: '
  'array of {name, args_summary, status}. Lets us reconstruct what actually executed vs what '
  'the agent said. No PII beyond what the message body already stores.';
