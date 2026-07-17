<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/bootstrap_api.php';

$pdo = db();
$actor = require_actor();
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    if ($actor['type'] === 'admin') {
        require_admin_permission($pdo, $actor, 'inventory');

        // Lightweight count-only mode for the quiet-poll bell badge —
        // never returns row data, just how many products are at/under
        // the low-stock threshold right now.
        if (str_field($_GET, 'lowstock_count') === '1') {
            $threshold = defined('LOW_STOCK_THRESHOLD') ? LOW_STOCK_THRESHOLD : 1;
            $stmt = $pdo->prepare('SELECT COUNT(*) FROM products WHERE deleted = 0 AND qty <= ?');
            $stmt->execute([$threshold]);
            json_response(['count' => (int) $stmt->fetchColumn()]);
        }

        $storeFilter = str_field($_GET, 'store_id');
        $sql = 'SELECT p.id, p.name, p.qty, p.dropped_off_at, p.created_at, p.qty_updated_at, p.qty_updated_by, s.store_name, s.store_id
                FROM products p JOIN stores s ON s.id = p.store_id WHERE p.deleted = 0';
        $params = [];
        if ($storeFilter !== '' && $storeFilter !== 'all') {
            $sql .= ' AND s.store_id = ?';
            $params[] = $storeFilter;
        }
        $sql .= ' ORDER BY s.store_name, p.name';
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        json_response(['products' => $stmt->fetchAll()]);
    }

    // Store actor (owner or team member) — a team member sees every
    // product their store holds, same as the owner. The "primarily
    // responsible for" tags are reference-only and don't filter this list.
    // qty_updated_at/qty_updated_by are included so a store can see who
    // (which admin) last confirmed their stock count and when.
    $stmt = $pdo->prepare('SELECT id, name, qty, dropped_off_at, created_at, qty_updated_at, qty_updated_by FROM products WHERE store_id = ? AND deleted = 0 ORDER BY name');
    $stmt->execute([$actor['owner_row_id']]);
    json_response(['products' => $stmt->fetchAll()]);
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
    // Everything past this point is admin-only. This is a real
    // integrity fix, not a UI-only restriction: a store could
    // previously call this endpoint directly (bypassing hidden
    // buttons) to quietly inflate stock after an order had already
    // been placed against it, or erase a logged row entirely. Both
    // quantity adjustment and row deletion/removal now require an
    // authenticated admin actor with the 'inventory' permission —
    // stores are limited server-side to viewing their inventory and
    // logging brand-new drop-offs (handled above in POST).
    require_admin();
    require_admin_permission($pdo, $actor, 'inventory');

    $body = read_json_body();
    $action = str_field($body, 'action');

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
