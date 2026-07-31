<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/bootstrap_api.php';

$pdo = db();
$actor = require_actor();
$method = $_SERVER['REQUEST_METHOD'];

// Same reserving-status list as orders.php (kept in sync manually since
// the two endpoints don't share a common include for this): an order
// still counts against a product's reserved quantity until it reaches a
// resolved end state (Delivered/Remitted have already deducted physical
// stock; Cancelled/Returned never held any under this model).
const RESERVING_STATUSES = ['pending', 'scheduled', 'transit', 'notpicking', 'issue'];

function attach_available_qty(array $products): array
{
    return array_map(function ($p) {
        $p['qty'] = (int) $p['qty'];
        $p['reserved'] = (int) $p['reserved'];
        $p['available'] = max(0, $p['qty'] - $p['reserved']);
        return $p;
    }, $products);
}

if ($method === 'GET') {
    $reservingPlaceholders = implode(',', array_fill(0, count(RESERVING_STATUSES), '?'));

    if ($actor['type'] === 'admin') {
        require_admin_permission($pdo, $actor, 'inventory');

        // Lightweight count-only mode for the quiet-poll bell badge —
        // never returns row data, just how many products are at/under the
        // low-stock threshold right now, based on *available* quantity
        // (physical minus reserved), since that's what actually
        // determines whether a new order can be fulfilled without
        // becoming a backorder.
        if (str_field($_GET, 'lowstock_count') === '1') {
            $threshold = defined('LOW_STOCK_THRESHOLD') ? LOW_STOCK_THRESHOLD : 1;
            $stmt = $pdo->prepare("SELECT COUNT(*) FROM products p WHERE p.deleted = 0
                AND GREATEST(0, p.qty - (SELECT COALESCE(SUM(o.qty), 0) FROM orders o WHERE o.product_id = p.id AND o.deleted = 0 AND o.status IN ($reservingPlaceholders))) <= ?");
            $stmt->execute(array_merge(RESERVING_STATUSES, [$threshold]));
            json_response(['count' => (int) $stmt->fetchColumn()]);
        }

        $storeFilter = str_field($_GET, 'store_id');
        $sql = "SELECT p.id, p.name, p.qty, p.dropped_off_at, p.created_at, p.qty_updated_at, p.qty_updated_by, s.store_name, s.store_id,
                (SELECT COALESCE(SUM(o.qty), 0) FROM orders o WHERE o.product_id = p.id AND o.deleted = 0 AND o.status IN ($reservingPlaceholders)) AS reserved
                FROM products p JOIN stores s ON s.id = p.store_id WHERE p.deleted = 0";
        $params = RESERVING_STATUSES;
        if ($storeFilter !== '' && $storeFilter !== 'all') {
            $sql .= ' AND s.store_id = ?';
            $params[] = $storeFilter;
        }
        $sql .= ' ORDER BY s.store_name, p.name';
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        json_response(['products' => attach_available_qty($stmt->fetchAll())]);
    }

    // Store actor (owner or team member) — a team member sees every
    // product their store holds, same as the owner. The "primarily
    // responsible for" tags are reference-only and don't filter this list.
    // qty_updated_at/qty_updated_by are included so a store can see who
    // (which admin) last confirmed their stock count and when.
    $sql = "SELECT p.id, p.name, p.qty, p.dropped_off_at, p.created_at, p.qty_updated_at, p.qty_updated_by,
            (SELECT COALESCE(SUM(o.qty), 0) FROM orders o WHERE o.product_id = p.id AND o.deleted = 0 AND o.status IN ($reservingPlaceholders)) AS reserved
            FROM products p WHERE p.store_id = ? AND p.deleted = 0 ORDER BY p.name";
    $stmt = $pdo->prepare($sql);
    $stmt->execute(array_merge(RESERVING_STATUSES, [$actor['owner_row_id']]));
    json_response(['products' => attach_available_qty($stmt->fetchAll())]);
}

if ($method === 'POST') {
    // Logging a brand-new drop-off stays store-only — this is the one
    // inventory action a store keeps full self-service control over.
    if ($actor['type'] !== 'store') {
        json_error('Only a store can log stock drop-offs.', 403);
    }
    require_store_permission($pdo, $actor, 'inventory');

    $body = read_json_body();
    $name = str_field($body, 'name');
    $qty = (int) num_field($body, 'qty', -1);
    $droppedOffAt = str_field($body, 'droppedOffAt');
    if ($droppedOffAt === '' || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $droppedOffAt)) {
        $droppedOffAt = date('Y-m-d');
    }

    if ($name === '' || $qty < 0) {
        json_error('Enter a product name and a valid quantity.', 400);
    }

    $stmt = $pdo->prepare('INSERT INTO products (store_id, name, qty, dropped_off_at) VALUES (?, ?, ?, ?)');
    $stmt->execute([$actor['owner_row_id'], $name, $qty, $droppedOffAt]);

    json_response(['id' => (int) $pdo->lastInsertId(), 'name' => $name, 'qty' => $qty, 'droppedOffAt' => $droppedOffAt], 201);
}

if ($method === 'PATCH') {
    $body = read_json_body();
    $action = str_field($body, 'action');

    // Fixing a typo in the product name is open to both a store (its own
    // products only) and an admin (any product) — separate from
    // quantity, which stays admin-only below. Renaming can't be used to
    // smuggle a quantity change (it never touches qty), so there's no
    // integrity concern in letting a store correct its own listing.
    if ($action === 'rename') {
        $id = (int) ($body['id'] ?? 0);
        $newName = str_field($body, 'name');
        if ($id <= 0 || $newName === '') {
            json_error('Enter a product name.', 400);
        }

        // Existence (and ownership, for a store) is checked with its own
        // SELECT rather than trusting UPDATE's affected-row count — PDO's
        // MySQL driver reports rows *changed*, not rows *matched*, so
        // resaving the exact same name as a no-op edit would otherwise
        // come back as a false "not found" even though the row is right
        // there and the request was perfectly valid.
        if ($actor['type'] === 'store') {
            require_store_permission($pdo, $actor, 'inventory');
            $stmt = $pdo->prepare('SELECT 1 FROM products WHERE id = ? AND store_id = ? AND deleted = 0');
            $stmt->execute([$id, $actor['owner_row_id']]);
            if (!$stmt->fetchColumn()) {
                json_error('Product not found.', 404);
            }
            $pdo->prepare('UPDATE products SET name = ? WHERE id = ? AND store_id = ? AND deleted = 0')
                ->execute([$newName, $id, $actor['owner_row_id']]);
        } else {
            require_admin_permission($pdo, $actor, 'inventory');
            $stmt = $pdo->prepare('SELECT 1 FROM products WHERE id = ? AND deleted = 0');
            $stmt->execute([$id]);
            if (!$stmt->fetchColumn()) {
                json_error('Product not found.', 404);
            }
            $pdo->prepare('UPDATE products SET name = ? WHERE id = ? AND deleted = 0')
                ->execute([$newName, $id]);
        }
        json_response(['id' => $id, 'name' => $newName]);
    }

    // Everything past this point is admin-only. This is a real
    // integrity fix, not a UI-only restriction: a store could
    // previously call this endpoint directly (bypassing hidden
    // buttons) to quietly inflate stock after an order had already
    // been placed against it, or erase a logged row entirely. Both
    // quantity adjustment and row deletion/removal now require an
    // authenticated admin actor with the 'inventory' permission —
    // stores are limited server-side to viewing their inventory,
    // logging brand-new drop-offs (POST above), and renaming their own
    // products (handled above).
    require_admin();
    require_admin_permission($pdo, $actor, 'inventory');

    $stmt = $pdo->prepare('SELECT name FROM admin_accounts WHERE id = ?');
    $stmt->execute([$actor['row_id']]);
    $adminName = (string) $stmt->fetchColumn();

    // Bulk delete
    if ($action === 'bulk_delete') {
        $ids = array_map('intval', $body['ids'] ?? []);
        if (!$ids) {
            json_error('No products specified.', 400);
        }
        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $pdo->prepare("UPDATE products SET deleted = 1 WHERE id IN ($placeholders)")->execute($ids);
        json_response(['ok' => true]);
    }

    // Single delete
    if ($action === 'delete') {
        $id = (int) ($body['id'] ?? 0);
        if ($id <= 0) {
            json_error('No product specified.', 400);
        }
        $stmt = $pdo->prepare('UPDATE products SET deleted = 1 WHERE id = ?');
        $stmt->execute([$id]);
        if ($stmt->rowCount() === 0) {
            json_error('Product not found.', 404);
        }
        json_response(['ok' => true]);
    }

    // Quantity adjustment — confirming stock against what was
    // physically received. Every adjustment is timestamped and
    // attributed for accounting.
    $id = (int) ($body['id'] ?? 0);
    $delta = (int) num_field($body, 'delta', 0);

    if ($id <= 0 || $delta === 0) {
        json_error('Nothing to update.', 400);
    }

    $stmt = $pdo->prepare('UPDATE products SET qty = GREATEST(0, qty + ?), qty_updated_at = CURRENT_TIMESTAMP, qty_updated_by = ? WHERE id = ? AND deleted = 0');
    $stmt->execute([$delta, $adminName, $id]);

    if ($stmt->rowCount() === 0) {
        json_error('Product not found.', 404);
    }

    $stmt = $pdo->prepare('SELECT qty, qty_updated_at, qty_updated_by FROM products WHERE id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    json_response(['id' => $id, 'qty' => (int) $row['qty'], 'qtyUpdatedAt' => $row['qty_updated_at'], 'qtyUpdatedBy' => $row['qty_updated_by']]);
}

json_error('Method not allowed.', 405);
