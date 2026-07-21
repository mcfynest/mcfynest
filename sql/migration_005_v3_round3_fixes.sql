-- Manifest / McFynest Logistics — migration 005 (v3 round 3 fixes)
-- Additive only: safe to run against live database. Adds fields for the
-- reworked stock model (round 3 item #4):
-- - orders.stock_deducted: whether physical stock has already been
--   decremented for this order. Deduction now happens exactly once, the
--   moment an order first reaches Delivered/Remitted — never at order
--   placement — and this flag is what makes that idempotent (Undo, or a
--   manual status change back out of Delivered/Remitted, adds the stock
--   back and clears the flag).
-- - orders.is_backorder: set at placement time when the requested qty
--   exceeded what was available (physical stock minus everything still
--   reserved by unresolved orders for that product). Backorders are
--   explicitly allowed, never blocked — this flag is purely informational
--   (shown as a "⏳ Backorder" badge) and never restricts what dispatch
--   can do with the order afterward.
--
-- Note: the existing orders.restocked column (added in migration 002) is
-- no longer used going forward — the manual "Restock" flow it supported
-- has been removed, since nothing is deducted for cancelled/failed/
-- returned orders in the first place under this model. Left in place
-- rather than dropped, consistent with this project's additive-only
-- migration policy; it's only read below, one time, to avoid
-- double-crediting stock that was already manually restocked.
--
-- IMPORTANT — reconciling existing data: under the OLD model, physical
-- stock was decremented for EVERY order at the moment it was placed,
-- regardless of status. Simply adding the two columns above and moving
-- on would leave live inventory counts wrong the moment this deploys:
-- - Orders already Delivered/Remitted correctly hold their deduction —
--   they just need stock_deducted flipped to 1 so a future Undo/reversal
--   credits it back exactly once instead of not crediting it at all.
-- - Orders still pending/scheduled/shipped/transit/not-picking/issue had
--   stock deducted at creation even though nothing should be deducted
--   until Delivered under the new model — that needs crediting back now,
--   otherwise it deducts AGAIN the first time it reaches Delivered.
-- - Orders already Cancelled/Returned (and never manually restocked) are
--   exactly the "stock stuck short forever" bug this whole rework exists
--   to fix — that stock needs crediting back now too.
-- Soft-deleted (trashed) orders are left untouched here; they're already
-- excluded from every reservation/deduction calculation going forward,
-- and reconciling their historical stock impact is a separate, unrelated
-- concern this migration does not attempt to resolve.
--
-- Import via phpMyAdmin exactly like the earlier migrations.

SET NAMES utf8mb4;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS stock_deducted TINYINT(1) NOT NULL DEFAULT 0 AFTER restocked,
  ADD COLUMN IF NOT EXISTS is_backorder TINYINT(1) NOT NULL DEFAULT 0 AFTER stock_deducted;

-- ---------------------------------------------------------------------
-- Case A: already Delivered/Remitted — the deduction that happened at
-- creation time under the old model is exactly the deduction the new
-- model expects to exist for a Delivered/Remitted order. Just flag it.
-- ---------------------------------------------------------------------
UPDATE orders
SET stock_deducted = 1
WHERE status IN ('delivered', 'remitted') AND deleted = 0;

-- ---------------------------------------------------------------------
-- Case B: still unresolved (not yet Delivered) — credit back the
-- premature creation-time deduction. When one of these later reaches
-- Delivered/Remitted, the new application-level logic deducts it fresh,
-- exactly once.
-- ---------------------------------------------------------------------
UPDATE products p
JOIN (
    SELECT product_id, SUM(qty) AS qty_to_credit
    FROM orders
    WHERE product_id IS NOT NULL AND deleted = 0
      AND status IN ('pending', 'scheduled', 'shipped', 'transit', 'notpicking', 'issue')
    GROUP BY product_id
) o ON o.product_id = p.id
SET p.qty = p.qty + o.qty_to_credit;

-- ---------------------------------------------------------------------
-- Case C: already Cancelled/Returned and never manually restocked —
-- this is precisely the "stock left permanently short" bug the round 3
-- stock rework was written to eliminate going forward. Credit it back
-- now. (Rows already restocked = 1 were already credited back manually
-- through the old Restock button — skipped here to avoid double-crediting.)
-- ---------------------------------------------------------------------
UPDATE products p
JOIN (
    SELECT product_id, SUM(qty) AS qty_to_credit
    FROM orders
    WHERE product_id IS NOT NULL AND deleted = 0
      AND status IN ('cancelled', 'returned') AND restocked = 0
    GROUP BY product_id
) o ON o.product_id = p.id
SET p.qty = p.qty + o.qty_to_credit;
