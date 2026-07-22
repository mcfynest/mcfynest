-- Manifest / McFynest Logistics — migration 006 (v3 round 4 fixes)
-- Additive only: safe to run against live database. Adds fields for:
-- - orders.status_history: a JSON array of {status, at, by} entries,
--   appended every time an order's status actually changes (Update
--   modal, bulk status change, Undo, or a report being sent). Powers the
--   status timeline printed on order slips (round 4 item #1). Existing
--   orders are left with NULL here rather than backfilled — the print
--   function falls back to synthesizing a single-entry history from the
--   order's current status/updated_at/last_updated_by when this is
--   empty, so nothing needs reconciling for orders that predate this
--   column.
-- - sent_reports.order_ids: a JSON array of the exact order codes marked
--   Remitted and included in that sent report (round 4 item #2) — this
--   is now the authoritative record of what was actually sent, replacing
--   the old behavior of inferring it from a date range after the fact.
--   date_from/date_to are kept as descriptive context (the report view
--   the admin was looking at when they sent it) but are no longer what
--   determines which orders get marked Remitted.
--
-- Import via phpMyAdmin exactly like the earlier migrations.

SET NAMES utf8mb4;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS status_history JSON NULL AFTER is_backorder;

ALTER TABLE sent_reports
  ADD COLUMN IF NOT EXISTS order_ids JSON NULL AFTER sent_by_admin_id;
