-- Manifest — Dispatch & Order Management
-- MySQL / MariaDB schema. Import this via phpMyAdmin (cPanel) into the
-- database you create for this app. Safe to re-run: uses IF NOT EXISTS
-- and drops nothing.

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------------
-- stores: store owner accounts and their team-member (agent) accounts.
-- An owner row has parent_store_id = NULL. An agent row has
-- parent_store_id pointing at its owner's row, and role = 'agent'.
-- Every row (owner or agent) has its own unique store_id + password —
-- that is what people actually log in with.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stores (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  store_id VARCHAR(20) NOT NULL,
  store_name VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('owner','agent') NOT NULL DEFAULT 'owner',
  parent_store_id INT UNSIGNED DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  failed_logins TINYINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_store_id (store_id),
  KEY idx_parent_store (parent_store_id),
  CONSTRAINT fk_stores_parent FOREIGN KEY (parent_store_id) REFERENCES stores(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- admin_accounts: dispatch admin / logistics staff logins. Same
-- ID + password model, kept separate from stores since admins are not
-- scoped to a single store.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_accounts (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  admin_id VARCHAR(20) NOT NULL,
  name VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  failed_logins TINYINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_admin_id (admin_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- products: inventory items. Always owned by an owner-role store row
-- (never by an agent row) — agents act on their parent store's products.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  store_id INT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  qty INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_products_store (store_id),
  CONSTRAINT fk_products_store FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- agent_products: which products an agent (team member) is restricted
-- to. Enforced server-side on every read/write, not just hidden in UI.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_products (
  agent_store_id INT UNSIGNED NOT NULL,
  product_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (agent_store_id, product_id),
  CONSTRAINT fk_ap_agent FOREIGN KEY (agent_store_id) REFERENCES stores(id) ON DELETE CASCADE,
  CONSTRAINT fk_ap_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_code VARCHAR(20) NOT NULL,
  store_id INT UNSIGNED NOT NULL,
  placed_by_store_id INT UNSIGNED NOT NULL,
  product_id INT UNSIGNED DEFAULT NULL,
  product_name VARCHAR(255) NOT NULL,
  qty INT NOT NULL DEFAULT 1,
  customer_name VARCHAR(255) NOT NULL,
  phone VARCHAR(50) NOT NULL,
  delivery_address TEXT NOT NULL,
  instructions TEXT,
  status ENUM('pending','transit','delivered','issue','cancelled') NOT NULL DEFAULT 'pending',
  rider VARCHAR(255) DEFAULT NULL,
  dispatch_note TEXT,
  delivery_fee DECIMAL(10,2) NOT NULL DEFAULT 0,
  other_charges DECIMAL(10,2) NOT NULL DEFAULT 0,
  charge_note VARCHAR(255) DEFAULT NULL,
  seen_by_admin TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_order_code (order_code),
  KEY idx_orders_store (store_id),
  KEY idx_orders_status (status),
  KEY idx_orders_seen (seen_by_admin),
  KEY idx_orders_created (created_at),
  CONSTRAINT fk_orders_store FOREIGN KEY (store_id) REFERENCES stores(id),
  CONSTRAINT fk_orders_placed_by FOREIGN KEY (placed_by_store_id) REFERENCES stores(id),
  CONSTRAINT fk_orders_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
