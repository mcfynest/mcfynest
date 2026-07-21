<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/bootstrap_api.php';

$pdo = db();
$actor = require_actor();
$method = $_SERVER['REQUEST_METHOD'];

const ORDER_STATUSES = ['pending', 'scheduled', 'shipped', 'transit', 'delivered', 'remitted', 'notpicking', 'issue', 'returned', 'cancelled'];
// Once an order is Delivered, a direct status change may only move it
// forward to Remitted — reversing it back to an earlier status goes
// through the dedicated 'undo' action instead, never a regular update.
const POST_DELIVERED_ALLOWED_STATUSES = ['delivered', 'remitted'];
// Statuses that still count against a product's reserved quantity —
// i.e. the order hasn't reached a resolved end state yet. Delivered/
// Remitted have already deducted physical stock (see stock_deducted
// below) so they stop reserving; Cancelled/Returned never held stock
// in the first place under this model, so they never reserved either.
const RESERVING_STATUSES = ['pending', 'scheduled', 'shipped', 'transit', 'notpicking', 'issue'];

/**
 * Physical stock is deducted exactly once, the moment an order first
 * reaches Delivered/Remitted — never at order placement. Reversing out
 * of Delivered/Remitted (Undo, or a manual status change back) adds it
 * back. The stock_deducted flag is the single source of truth for
 * whether a deduction actually happened, so this is always idempotent
 * regardless of how many times a status flips back and forth.
 */
function apply_stock_for_status_change(PDO $pdo, array $order, string $oldStatus, string $newStatus): void
{
    if (!$order['product_id']) {
        return;
    }
    $wasDelivered = in_array($oldStatus, POST_DELIVERED_ALLOWED_STATUSES, true);
    $isDelivered = in_array($newStatus, POST_DELIVERED_ALLOWED_STATUSES, true);

    if (!$wasDelivered && $isDelivered && !$order['stock_deducted']) {
        $pdo->prepare('UPDATE products SET qty = GREATEST(0, qty - ?) WHERE id = ?')
            ->execute([$order['qty'], $order['product_id']]);
        $pdo->prepare('UPDATE orders SET stock_deducted = 1 WHERE id = ?')->execute([$order['id']]);
    } elseif ($wasDelivered && !$isDelivered && $order['stock_deducted']) {
        $pdo->prepare('UPDATE products SET qty = qty + ? WHERE id = ?')
            ->execute([$order['qty'], $order['product_id']]);
        $pdo->prepare('UPDATE orders SET stock_deducted = 0 WHERE id = ?')->execute([$order['id']]);
    }
}

function order_row_for_client(array $o): array
{
    return [
        'id' => $o['order_code'],
        'store' => $o['store_name'],
        'storeId' => $o['store_login_id'] ?? null,
        'item' => $o['product_name'],
        'qty' => (int) $o['qty'],
        'customer' => $o['customer_name'],
        'phone' => $o['phone'],
        'altPhone' => $o['alt_phone'],
        'dropoff' => $o['delivery_address'],
        'zone' => $o['zone'],
        'notes' => $o['instructions'],
        'amount' => (float) $o['amount'],
        'status' => $o['status'],
        'prevStatus' => $o['prev_status'],
        'deleted' => (bool) $o['deleted'],
        'rider' => $o['rider'],
        'remark' => $o['dispatch_note'],
        'deliveryFee' => (float) $o['delivery_fee'],
        'otherCharges' => (float) $o['other_charges'],
        'chargeNote' => $o['charge_note'],
        'seen' => (bool) $o['seen_by_admin'],
        'isBackorder' => (bool) $o['is_backorder'],
        'stockDeducted' => (bool) $o['stock_deducted'],
        'lastUpdatedBy' => $o['last_updated_by_name'],
        'createdAt' => strtotime($o['created_at']) * 1000,
        'updatedAt' => strtotime($o['updated_at']) * 1000,
    ];
}

if ($method === 'GET') {
    $wantTrash = str_field($_GET, 'trash') === '1';

    if ($actor['type'] === 'admin') {
        if ($wantTrash) {
            require_admin_permission($pdo, $actor, 'trash');
        } else {
            require_admin_permission($pdo, $actor, 'orders');
        }
        $storeFilter = str_field($_GET, 'store_id');
        $statusFilter = str_field($_GET, 'status');
        $q = str_field($_GET, 'q');

        $sql = 'SELECT o.*, s.store_name, s.store_id AS store_login_id
                FROM orders o JOIN stores s ON s.id = o.store_id WHERE o.deleted = ' . ($wantTrash ? '1' : '0');
        $params = [];

        if ($storeFilter !== '' && $storeFilter !== 'all') {
            $sql .= ' AND s.store_id = ?';
            $params[] = $storeFilter;
        }
        if ($statusFilter !== '' && $statusFilter !== 'all') {
            $sql .= ' AND o.status = ?';
            $params[] = $statusFilter;
        }
        if ($q !== '') {
            $sql .= ' AND (o.customer_name LIKE ? OR o.phone LIKE ? OR o.order_code LIKE ?)';
            $like = '%' . $q . '%';
            $params[] = $like;
            $params[] = $like;
            $params[] = $like;
        }
        apply_date_range($sql, $params, $wantTrash ? 'o.updated_at' : 'o.created_at');
        $sql .= ' ORDER BY ' . ($wantTrash ? 'o.updated_at DESC' : 'o.created_at DESC') . ' LIMIT 1000';

        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        json_response(['orders' => array_map('order_row_for_client', $stmt->fetchAll())]);
    }

    // Store actor (owner or team member) — both see every order for
    // their store. Viewing the store's own trashed orders (so they can
    // self-restore a mistaken delete) is gated on the 'order' permission
    // — the same permission that governs moving an order to Trash in the
    // first place. Viewing normal order history stays gated on 'history'.
    if ($wantTrash) {
        require_store_permission($pdo, $actor, 'order');
        $sql = 'SELECT o.*, s.store_name FROM orders o JOIN stores s ON s.id = o.store_id
                WHERE o.store_id = ? AND o.deleted = 1';
        $params = [$actor['owner_row_id']];
        apply_date_range($sql, $params, 'o.updated_at');
        $sql .= ' ORDER BY o.updated_at DESC LIMIT 1000';
    } else {
        require_store_permission($pdo, $actor, 'history');
        $sql = 'SELECT o.*, s.store_name FROM orders o JOIN stores s ON s.id = o.store_id
                WHERE o.store_id = ? AND o.deleted = 0';
        $params = [$actor['owner_row_id']];
        apply_date_range($sql, $params, 'o.created_at');
        $sql .= ' ORDER BY o.created_at DESC LIMIT 1000';
    }

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    json_response(['orders' => array_map('order_row_for_client', $stmt->fetchAll())]);
}

if ($method === 'POST') {
    if ($actor['type'] !== 'store') {
        json_error('Only a store can raise an order.', 403);
    }
    require_store_permission($pdo, $actor, 'order');

    $body = read_json_body();
    $productId = (int) ($body['product_id'] ?? 0);
    $customer = str_field($body, 'customer');
    $phone = str_field($body, 'phone');
    $altPhone = str_field($body, 'altPhone');
    $dropoff = str_field($body, 'dropoff');
    $zone = str_field($body, 'zone');
    $notes = str_field($body, 'notes');
    $amount = max(0, num_field($body, 'amount', 0));
    $qty = max(1, (int) num_field($body, 'qty', 1));

    if ($productId <= 0 || $customer === '' || $phone === '' || $dropoff === '') {
        json_error('Fill in customer name, product, address and phone number.', 400);
    }

    $pdo->beginTransaction();
    try {
        // Placing an order never touches physical stock — it only counts
        // against the product's reserved quantity (see RESERVING_STATUSES).
        // The row lock here is still what makes "available" a consistent
        // read under concurrent order placement, same guarantee the old
        // qty-decrement had; we just no longer mutate qty at this point.
        $stmt = $pdo->prepare('SELECT id, name, qty FROM products WHERE id = ? AND store_id = ? AND deleted = 0 FOR UPDATE');
        $stmt->execute([$productId, $actor['owner_row_id']]);
        $product = $stmt->fetch();

        if (!$product) {
            $pdo->rollBack();
            json_error('Product not found.', 404);
        }

        $placeholders = implode(',', array_fill(0, count(RESERVING_STATUSES), '?'));
        $stmt = $pdo->prepare("SELECT COALESCE(SUM(qty), 0) FROM orders WHERE product_id = ? AND deleted = 0 AND status IN ($placeholders)");
        $stmt->execute(array_merge([$productId], RESERVING_STATUSES));
        $reserved = (int) $stmt->fetchColumn();
        $available = max(0, (int) $product['qty'] - $reserved);

        // Backorders are explicitly allowed — never blocked server-side.
        // is_backorder is computed here (not trusted from the client) so
        // the badge is always accurate regardless of what the client sent.
        $isBackorder = $qty > $available;

        $orderCode = generate_order_code($pdo);
        $stmt = $pdo->prepare('INSERT INTO orders
            (order_code, store_id, placed_by_store_id, product_id, product_name, qty, customer_name, phone, alt_phone, delivery_address, zone, instructions, amount, is_backorder)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        $stmt->execute([
            $orderCode, $actor['owner_row_id'], $actor['row_id'], $productId, $product['name'], $qty,
            $customer, $phone, $altPhone ?: null, $dropoff, $zone ?: null, $notes, $amount, $isBackorder ? 1 : 0,
        ]);

        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    json_response(['order_code' => $orderCode, 'is_backorder' => $isBackorder], 201);
}

if ($method === 'PATCH') {
    $body = read_json_body();
    $action = str_field($body, 'action');

    // Move to Trash (soft-delete) — a store can trash its own orders,
    // an admin can trash any order. Permanent delete stays admin-only
    // (gated on 'trash') below.
    if ($action === 'trash' || $action === 'delete') {
        $orderCode = str_field($body, 'id');
        if ($orderCode === '') {
            json_error('Missing order id.', 400);
        }
        if ($actor['type'] === 'store') {
            require_store_permission($pdo, $actor, 'order');
            $stmt = $pdo->prepare('UPDATE orders SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE order_code = ? AND store_id = ?');
            $stmt->execute([$orderCode, $actor['owner_row_id']]);
        } else {
            require_admin_permission($pdo, $actor, 'orders');
            $stmt = $pdo->prepare('UPDATE orders SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE order_code = ?');
            $stmt->execute([$orderCode]);
        }
        if ($stmt->rowCount() === 0) {
            json_error('Order not found.', 404);
        }
        json_response(['ok' => true]);
    }

    // Bulk move to Trash
    if ($action === 'bulk_trash') {
        $ids = array_values(array_filter(array_map('strval', $body['ids'] ?? [])));
        if (!$ids) {
            json_error('No orders specified.', 400);
        }
        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        if ($actor['type'] === 'store') {
            require_store_permission($pdo, $actor, 'order');
            $pdo->prepare("UPDATE orders SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE order_code IN ($placeholders) AND store_id = ?")
                ->execute(array_merge($ids, [$actor['owner_row_id']]));
        } else {
            require_admin_permission($pdo, $actor, 'orders');
            $pdo->prepare("UPDATE orders SET deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE order_code IN ($placeholders)")->execute($ids);
        }
        json_response(['ok' => true]);
    }

    // Bulk status change — each order's prev_status is set to whatever
    // ITS OWN status was before this change (not a single shared value),
    // and only when that order actually changes status. Orders currently
    // Delivered are silently skipped if the target status isn't
    // Delivered/Remitted, rather than failing the whole batch.
    if ($action === 'bulk_status') {
        $ids = array_values(array_filter(array_map('strval', $body['ids'] ?? [])));
        $status = str_field($body, 'status');
        if (!$ids) {
            json_error('No orders specified.', 400);
        }
        if (!in_array($status, ORDER_STATUSES, true)) {
            json_error('Invalid status.', 400);
        }
        require_admin();
        require_admin_permission($pdo, $actor, 'orders');

        $stmt = $pdo->prepare('SELECT name FROM admin_accounts WHERE id = ?');
        $stmt->execute([$actor['row_id']]);
        $adminName = (string) $stmt->fetchColumn();

        $updated = 0;
        $skipped = 0;
        $pdo->beginTransaction();
        try {
            $placeholders = implode(',', array_fill(0, count($ids), '?'));
            $stmt = $pdo->prepare("SELECT id, order_code, status, product_id, qty, stock_deducted FROM orders WHERE order_code IN ($placeholders) AND deleted = 0 FOR UPDATE");
            $stmt->execute($ids);
            $rows = $stmt->fetchAll();

            $upd = $pdo->prepare('UPDATE orders SET status = ?, prev_status = ?, last_updated_by_name = ?, seen_by_admin = 1, updated_at = CURRENT_TIMESTAMP WHERE order_code = ?');
            foreach ($rows as $row) {
                $current = $row['status'];
                if ($current === $status) {
                    continue;
                }
                if ($current === 'delivered' && !in_array($status, POST_DELIVERED_ALLOWED_STATUSES, true)) {
                    $skipped++;
                    continue;
                }
                $upd->execute([$status, $current, $adminName, $row['order_code']]);
                apply_stock_for_status_change($pdo, $row, $current, $status);
                $updated++;
            }
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
        json_response(['ok' => true, 'updated' => $updated, 'skipped' => $skipped]);
    }

    // Restore from Trash — a store can restore its own order (self-service
    // fix for an accidental trash click); an admin with 'trash' permission
    // can restore any order.
    if ($action === 'restore') {
        $orderCode = str_field($body, 'id');
        if ($orderCode === '') {
            json_error('Missing order id.', 400);
        }
        if ($actor['type'] === 'store') {
            require_store_permission($pdo, $actor, 'order');
            $stmt = $pdo->prepare('UPDATE orders SET deleted = 0, updated_at = CURRENT_TIMESTAMP WHERE order_code = ? AND store_id = ?');
            $stmt->execute([$orderCode, $actor['owner_row_id']]);
        } else {
            require_admin();
            require_admin_permission($pdo, $actor, 'trash');
            $stmt = $pdo->prepare('UPDATE orders SET deleted = 0, updated_at = CURRENT_TIMESTAMP WHERE order_code = ?');
            $stmt->execute([$orderCode]);
        }
        if ($stmt->rowCount() === 0) {
            json_error('Order not found.', 404);
        }
        json_response(['ok' => true]);
    }

    // Undo — reverses an order back to whatever status it had
    // immediately before its last change. Dispatch-status changes are
    // an admin-only capability everywhere else (Update modal, bulk
    // status change), so reversing one is admin-only too; a store never
    // sets an order's dispatch status in the first place, so there is
    // never a store-caused status change for it to undo. (A store's own
    // mistake — accidentally moving an order to Trash — is undone via
    // the 'restore' action above instead.)
    if ($action === 'undo') {
        require_admin();
        require_admin_permission($pdo, $actor, 'orders');
        $orderCode = str_field($body, 'id');
        if ($orderCode === '') {
            json_error('Missing order id.', 400);
        }

        $stmt = $pdo->prepare('SELECT name FROM admin_accounts WHERE id = ?');
        $stmt->execute([$actor['row_id']]);
        $adminName = (string) $stmt->fetchColumn();

        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare('SELECT id, status, prev_status, product_id, qty, stock_deducted FROM orders WHERE order_code = ? AND deleted = 0 FOR UPDATE');
            $stmt->execute([$orderCode]);
            $order = $stmt->fetch();
            if (!$order) {
                $pdo->rollBack();
                json_error('Order not found.', 404);
            }
            if (!$order['prev_status']) {
                $pdo->rollBack();
                json_error('Nothing to undo for this order.', 400);
            }
            $oldStatus = $order['status'];
            $pdo->prepare('UPDATE orders SET status = ?, prev_status = NULL, last_updated_by_name = ?, seen_by_admin = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
                ->execute([$order['prev_status'], $adminName, $order['id']]);
            apply_stock_for_status_change($pdo, $order, $oldStatus, $order['prev_status']);
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
        json_response(['ok' => true, 'status' => $order['prev_status']]);
    }

    // Single order update (admin dispatch update)
    require_admin();
    require_admin_permission($pdo, $actor, 'orders');
    $orderCode = str_field($body, 'id');
    if ($orderCode === '') {
        json_error('Missing order id.', 400);
    }

    $stmt = $pdo->prepare('SELECT name FROM admin_accounts WHERE id = ?');
    $stmt->execute([$actor['row_id']]);
    $adminName = (string) $stmt->fetchColumn();

    $status = str_field($body, 'status');
    if (!in_array($status, ORDER_STATUSES, true)) {
        json_error('Invalid status.', 400);
    }
    $rider = str_field($body, 'rider');
    $remark = str_field($body, 'remark');
    $deliveryFee = max(0, num_field($body, 'deliveryFee', 0));
    $otherCharges = max(0, num_field($body, 'otherCharges', 0));
    $chargeNote = str_field($body, 'chargeNote');

    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare('SELECT id, status, product_id, qty, stock_deducted FROM orders WHERE order_code = ? FOR UPDATE');
        $stmt->execute([$orderCode]);
        $existing = $stmt->fetch();
        if (!$existing) {
            $pdo->rollBack();
            json_error('Order not found.', 404);
        }
        $currentStatus = $existing['status'];

        if ($currentStatus === 'delivered' && !in_array($status, POST_DELIVERED_ALLOWED_STATUSES, true)) {
            $pdo->rollBack();
            json_error('A Delivered order can only move to Delivered or Remitted here — use Undo on the order to reverse it instead.', 400);
        }

        // Every save from the Update modal marks the order seen, whether
        // or not the status itself actually changed — a dispatcher who
        // opened and saved an order has "actioned" it either way.
        if ($status !== $currentStatus) {
            $stmt = $pdo->prepare('UPDATE orders SET status=?, prev_status=?, rider=?, dispatch_note=?, delivery_fee=?, other_charges=?, charge_note=?, last_updated_by_name=?, seen_by_admin=1 WHERE order_code=?');
            $stmt->execute([$status, $currentStatus, $rider, $remark, $deliveryFee, $otherCharges, $chargeNote, $adminName, $orderCode]);
            apply_stock_for_status_change($pdo, $existing, $currentStatus, $status);
        } else {
            $stmt = $pdo->prepare('UPDATE orders SET status=?, rider=?, dispatch_note=?, delivery_fee=?, other_charges=?, charge_note=?, last_updated_by_name=?, seen_by_admin=1 WHERE order_code=?');
            $stmt->execute([$status, $rider, $remark, $deliveryFee, $otherCharges, $chargeNote, $adminName, $orderCode]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    json_response(['ok' => true]);
}

if ($method === 'DELETE') {
    // Permanent delete — admin with 'trash' permission only, and only
    // ever on an order that's already sitting in Trash.
    require_admin();
    require_admin_permission($pdo, $actor, 'trash');
    $body = read_json_body();
    $orderCode = str_field($body, 'id');
    if ($orderCode === '') {
        json_error('Missing order id.', 400);
    }

    $stmt = $pdo->prepare('DELETE FROM orders WHERE order_code = ? AND deleted = 1');
    $stmt->execute([$orderCode]);
    if ($stmt->rowCount() === 0) {
        json_error('Order not found in Trash.', 404);
    }
    json_response(['ok' => true]);
}

json_error('Method not allowed.', 405);
