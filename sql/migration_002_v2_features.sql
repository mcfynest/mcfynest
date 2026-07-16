-- Manifest / McFynest Logistics — migration 002
-- Additive only: safe to run against a live database that already has
-- real stores, products and orders in it. Adds columns/tables for:
-- team positions & permissions, admin positions & permissions, stock
-- drop-off dates, order quantity/amount/alt-phone/restock/last-updated-by,
-- wallet + withdrawals, expenses, sent reports, and forgot-login requests.
--
-- Import via phpMyAdmin exactly like schema.sql (Import tab, choose this
-- file, Go). Run this once, after schema.sql has already been applied.

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------
-- stores: position/permissions for team members, bank details for owners
-- ---------------------------------------------------------------------
ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS position VARCHAR(255) NULL AFTER role,
  ADD COLUMN IF NOT EXISTS permissions JSON NULL AFTER position,
  ADD COLUMN IF NOT EXISTS bank_name VARCHAR(255) NULL AFTER permissions,
  ADD COLUMN IF NOT EXISTS bank_account_number VARCHAR(50) NULL AFTER bank_name,
  ADD COLUMN IF NOT EXISTS bank_account_name VARCHAR(255) NULL AFTER bank_account_number;

-- ---------------------------------------------------------------------
-- admin_accounts: position/permissions checklist
-- ---------------------------------------------------------------------
ALTER TABLE admin_accounts
  ADD COLUMN IF NOT EXISTS position VARCHAR(255) NULL AFTER name,
  ADD COLUMN IF NOT EXISTS permissions JSON NULL AFTER position;

-- ---------------------------------------------------------------------
-- products: date dropped off (shown on every inventory row)
-- ---------------------------------------------------------------------
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS dropped_off_at DATE NULL AFTER qty;

UPDATE products SET dropped_off_at = DATE(created_at) WHERE dropped_off_at IS NULL;

-- ---------------------------------------------------------------------
-- orders: quantity-aware amount/alt phone/restock/last-updated-by
-- (qty already existed from schema.sql, defaulting to 1)
-- ---------------------------------------------------------------------
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS alt_phone VARCHAR(50) NULL AFTER phone,
  ADD COLUMN IF NOT EXISTS amount DECIMAL(10,2) NOT NULL DEFAULT 0 AFTER instructions,
  ADD COLUMN IF NOT EXISTS restocked TINYINT(1) NOT NULL DEFAULT 0 AFTER seen_by_admin,
  ADD COLUMN IF NOT EXISTS last_updated_by_name VARCHAR(255) NULL AFTER restocked;

ALTER TABLE orders
  ADD INDEX IF NOT EXISTS idx_orders_updated (updated_at);

-- ---------------------------------------------------------------------
-- withdrawals: store wallet payout requests
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS withdrawals (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  store_id INT UNSIGNED NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  status ENUM('pending','paid','declined') NOT NULL DEFAULT 'pending',
  requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME NULL,
  resolved_by_admin_id INT UNSIGNED NULL,
  PRIMARY KEY (id),
  KEY idx_withdrawals_store (store_id),
  KEY idx_withdrawals_status (status),
  CONSTRAINT fk_withdrawals_store FOREIGN KEY (store_id) REFERENCES stores(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- expenses: admin-only rider pay / other costs, used to compute profit
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expenses (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  type ENUM('rider','other') NOT NULL DEFAULT 'other',
  description VARCHAR(255) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  order_ref VARCHAR(20) NULL,
  expense_date DATE NOT NULL,
  note VARCHAR(255) NULL,
  created_by_admin_id INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_expenses_date (expense_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- sent_reports: "your dispatch team sent a report" popup for stores
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sent_reports (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  store_id INT UNSIGNED NOT NULL,
  range_label VARCHAR(50) NOT NULL,
  date_from DATE NULL,
  date_to DATE NULL,
  sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_by_admin_id INT UNSIGNED NULL,
  acknowledged TINYINT(1) NOT NULL DEFAULT 0,
  acknowledged_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_sentreports_store (store_id),
  CONSTRAINT fk_sentreports_store FOREIGN KEY (store_id) REFERENCES stores(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- reset_requests: "forgot my ID/password" queue, reviewed by admin
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reset_requests (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  type ENUM('store','admin') NOT NULL,
  label VARCHAR(255) NOT NULL,
  contact VARCHAR(255) NOT NULL,
  resolved TINYINT(1) NOT NULL DEFAULT 0,
  resolved_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_resetreq_type (type, resolved)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
