-- Manifest / McFynest Logistics — migration 004 (v3 round 2 fixes)
-- Additive only: safe to run against live database. Adds fields for:
-- - orders.prev_status: single-level "undo" support (reverses to whatever
--   status an order had immediately before its last change)
-- - orders.zone: free-text delivery zone/area tag
-- - products.qty_updated_at / qty_updated_by: accountability trail for
--   the new admin-only quantity-adjustment rule (round 2 item #9)
-- - withdrawals.seen_by_admin: powers the new withdrawal-request popup/bell
--
-- New admin permission keys ("customers", "zones") live inside the existing
-- admin_accounts.permissions JSON column — no schema change needed for
-- those; they default to off for every already-created admin login, same
-- as any other unchecked permission, until explicitly granted.
--
-- Import via phpMyAdmin exactly like the earlier migrations.

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------
-- orders: single-level undo + delivery zone tag
-- ---------------------------------------------------------------------
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS prev_status VARCHAR(20) NULL AFTER status,
  ADD COLUMN IF NOT EXISTS zone VARCHAR(120) NULL AFTER delivery_address;

-- ---------------------------------------------------------------------
-- products: accountability trail for admin-only quantity adjustments.
-- Deliberately separate from the table's existing auto-updated
-- updated_at column, which also bumps on unrelated writes (order
-- placement decrementing stock, restock incrementing it, soft-delete) —
-- these two new columns are set ONLY by the admin-only quantity-adjust
-- endpoint, so "Last updated by" never misattributes an automatic
-- system change to an admin who didn't make it.
-- ---------------------------------------------------------------------
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS qty_updated_at DATETIME NULL AFTER updated_at,
  ADD COLUMN IF NOT EXISTS qty_updated_by VARCHAR(255) NULL AFTER qty_updated_at;

-- ---------------------------------------------------------------------
-- withdrawals: "seen" tracking for the new admin withdrawal-request popup
-- ---------------------------------------------------------------------
ALTER TABLE withdrawals
  ADD COLUMN IF NOT EXISTS seen_by_admin TINYINT(1) NOT NULL DEFAULT 0 AFTER status;
