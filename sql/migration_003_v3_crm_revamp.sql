-- Manifest / McFynest Logistics — migration 003 (v3 CRM revamp)
-- Additive only: safe to run against live database. Adds:
-- - orders.deleted flag (soft-delete for trash system)
-- - expanded order status enum (10 statuses instead of 5)
-- - misc cleanup and improvements
--
-- Import via phpMyAdmin exactly like schema.sql and migration_002.sql
--
-- Note: the app now recognizes a new admin permission key, "trash"
-- (gates the Deleted Orders section). This lives in admin_accounts.permissions
-- (JSON, no schema change needed) and defaults to OFF for every existing
-- admin login, same as any other unchecked permission. Grant it from the
-- Admin Team section (Reset password modal doesn't touch permissions —
-- use the permissions checklist when creating a new admin, or run a
-- one-off UPDATE if you need to grant it to an existing admin login
-- immediately, e.g.:
--   UPDATE admin_accounts SET permissions = JSON_SET(permissions, '$.trash', true) WHERE admin_id = 'ADM-0001';

SET NAMES utf8mb4;

-- Update orders status enum to include all 10 statuses
ALTER TABLE orders
  MODIFY COLUMN status ENUM(
    'pending','scheduled','shipped','transit','delivered','remitted',
    'notpicking','issue','returned','cancelled'
  ) NOT NULL DEFAULT 'pending';

-- Add deleted flag for soft-delete / trash system (orders)
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS deleted TINYINT(1) NOT NULL DEFAULT 0 AFTER status,
  ADD INDEX IF NOT EXISTS idx_orders_deleted (deleted);

-- Ensure alt_phone exists from previous migration (should be there, but belt-and-suspenders)
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS alt_phone VARCHAR(50) NULL AFTER phone;

-- Ensure amount field exists and is properly typed (migration 002 should have this)
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS amount DECIMAL(10,2) NOT NULL DEFAULT 0 AFTER instructions;

-- Add deleted flag for soft-delete / trash system (products)
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS deleted TINYINT(1) NOT NULL DEFAULT 0 AFTER updated_at,
  ADD INDEX IF NOT EXISTS idx_products_deleted (deleted);
