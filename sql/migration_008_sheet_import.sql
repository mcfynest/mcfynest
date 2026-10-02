-- Manifest / McFynest Logistics — migration 008 (round 6: Google Sheets import)
-- Additive only, safe to run against the live database. Nothing existing
-- is modified or backfilled.
--
-- - stores.sheet_api_key: per-store credential the store's Google Sheet
--   script uses to send new order rows to api/sheet-import.php. Separate
--   from (and never derived from) the store's login password, since it
--   lives inside an Apps Script that anyone with edit access to the Sheet
--   can read. Left NULL until first needed — the app generates it the
--   first time an admin reveals it or the store owner views it. UNIQUE
--   doubles as the index used to look a store up from a key on every
--   request. ASCII/binary collation so matching is exact.
--
-- - sheet_import_log: one row per request to api/sheet-import.php
--   (successes and every kind of failure: bad API key, invalid request,
--   validation error, rate limit, server error, duplicate). This is what
--   to check (phpMyAdmin → sheet_import_log, newest first) when a store
--   says "my sheet isn't syncing". It's also what the per-key rate limit
--   and duplicate-row protection count against. Rows older than 90 days
--   are pruned automatically by the endpoint.
--
-- Import via phpMyAdmin exactly like the earlier migrations.

SET NAMES utf8mb4;

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS sheet_api_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL AFTER bank_account_name,
  ADD UNIQUE KEY IF NOT EXISTS uq_sheet_api_key (sheet_api_key);

CREATE TABLE IF NOT EXISTS sheet_import_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  store_id INT UNSIGNED DEFAULT NULL,
  ip VARCHAR(45) DEFAULT NULL,
  outcome ENUM('success','duplicate','auth_failed','invalid_request','validation_error','rate_limited','server_error') NOT NULL,
  http_status SMALLINT UNSIGNED NOT NULL,
  error_message VARCHAR(500) DEFAULT NULL,
  order_code VARCHAR(20) DEFAULT NULL,
  payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  request_summary TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sil_store_created (store_id, created_at),
  KEY idx_sil_ip_outcome_created (ip, outcome, created_at),
  KEY idx_sil_created (created_at),
  CONSTRAINT fk_sil_store FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
