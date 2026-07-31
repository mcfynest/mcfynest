-- Manifest / McFynest Logistics — migration 007 (v3 round 5 fixes)
-- Additive/corrective, safe to run against the live database. This is
-- the only schema change round 5 needs — every other round 5 fix (the
-- "New"/"All" pill bug, money-blanking in reports, product renaming,
-- order detail editing, expense editing, the sent-reports sheet) reuses
-- columns that already exist as of migration 006.
--
-- Removes the legacy 'shipped' status. It was never distinguished from
-- 'transit' ("Out for delivery") in practice and cluttered the status
-- list — any order currently sitting in 'shipped' is moved to 'transit'
-- first, then the ENUM itself drops the value. This is safe for the
-- stock-reservation model: both statuses are "reserving, not yet
-- deducted" statuses, so moving between them doesn't touch stock at all.
--
-- Import via phpMyAdmin exactly like the earlier migrations.

SET NAMES utf8mb4;

UPDATE orders SET status = 'transit' WHERE status = 'shipped';

ALTER TABLE orders
  MODIFY COLUMN status ENUM(
    'pending','scheduled','transit','delivered','remitted',
    'notpicking','issue','returned','cancelled'
  ) NOT NULL DEFAULT 'pending';
