<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/bootstrap_api.php';

$pdo = db();
$actor = require_actor();
$method = $_SERVER['REQUEST_METHOD'];

const ORDER_STATUSES = ['pending', 'scheduled', 'shipped', 'transit', 'delivered', 'remitted', 'notpicking', 'issue', 'returned', 'cancelled'];
const RESTOCK_ELIGIBLE_STATUSES = ['cancelled', 'issue', 'returned'];

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
        'notes' => $o['instructions'],
        'amount' => (float) $o['amount'],
        'status' => $o['status'],
        'deleted' => (bool) $o['deleted'],
        'rider' => $o['rider'],
        'remark' => $o['dispatch_note'],
        'deliveryFee' => (float) $o['delivery_fee'],
        'otherCharges' => (float) $o['other_charges'],
        'chargeNote' => $o['charge_note'],
        'seen' => (bool) $o['seen_by_admin'],
        'restocked' => (bool) $o['restocked'],
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
    // their store, gated only by the "history" permission. Stores never
    // see their own trash query (trash is admin-only).
    require_store_permission($pdo, $actor, 'history');
    $sql = 'SELECT o.*, s.store_name FROM orders o JOIN stores s ON s.id = o.store_id
            WHERE o.store_id = ? AND o.deleted = 0';
    $params = [$actor['owner_row_id']];
    apply_date_range($sql, $params, 'o.created_at');
    $sql .= ' ORDER BY o.created_at DESC LIMIT 1000';

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
    $notes = str_field($body, 'notes');
    $amount = max(0, num_field($body, 'amount', 0));
    $qty = max(1, (int) num_field($body, 'qty', 1));

    if ($productId <= 0 || $customer === '' || $phone === '' || $dropoff === '') {
        json_error('Fill in customer name, product, address and phone number.', 400);
    }

    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare('SELECT id, name, qty FROM products WHERE id = ? AND store_id = ? AND deleted = 0 FOR UPDATE');
        $stmt->execute([$productId, $actor['owner_row_id']]);
        $product = $stmt->fetch();

        if (!$product) {
            $pdo->rollBack();
            json_error('Product not found.', 404);
        }
        if ((int) $product['qty'] < $qty) {
            $pdo->rollBack();
            json_error('Only ' . $product['qty'] . ' in stock.', 409);
        }

        $pdo->prepare('UPDATE products SET qty = qty - ? WHERE id = ?')->execute([$qty, $productId]);

        $orderCode = generate_order_code($pdo);
        $stmt = $pdo->prepare('INSERT INTO orders
            (order_code, store_id, placed_by_store_id, product_id, product_name, qty, customer_name, phone, alt_phone, delivery_address, instructions, amount)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        $stmt->execute([
            $orderCode, $actor['owner_row_id'], $actor['row_id'], $productId, $product['name'], $qty,
            $customer, $phone, $altPhone ?: null, $dropoff, $notes, $amount,
        ]);

        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    json_response(['order_code' => $orderCode], 201);
}

if ($method === 'PATCH') {
    $body = read_json_body();
    $action = str_field($body, 'action');

    // Move to Trash (soft-delete) — a store can trash its own orders,
    // an admin can trash any order. Restoring/permanent-delete stay
    // admin-only (gated on 'trash') below.
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

    // Bulk status change
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

        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $pdo->prepare("UPDATE orders SET status = ?, last_updated_by_name = ?, updated_at = CURRENT_TIMESTAMP WHERE order_code IN ($placeholders) AND deleted = 0")
            ->execute(array_merge([$status, $adminName], $ids));
        json_response(['ok' => true]);
    }

    // Restore from Trash (admin-only)
    if ($action === 'restore') {
        require_admin();
        require_admin_permission($pdo, $actor, 'trash');
        $orderCode = str_field($body, 'id');
        if ($orderCode === '') {
            json_error('Missing order id.', 400);
        }
        $stmt = $pdo->prepare('UPDATE orders SET deleted = 0, updated_at = CURRENT_TIMESTAMP WHERE order_code = ?');
        $stmt->execute([$orderCode]);
        if ($stmt->rowCount() === 0) {
            json_error('Order not found.', 404);
        }
        json_response(['ok' => true]);
    }

    // Restock: a manual, one-time action on a cancelled/issue/returned
    // order — never automatic.
    if ($action === 'restock') {
        require_admin();
        require_admin_permission($pdo, $actor, 'orders');
        $orderCode = str_field($body, 'id');

        $stmt = $pdo->prepare('SELECT name FROM admin_accounts WHERE id = ?');
        $stmt->execute([$actor['row_id']]);
        $adminName = (string) $stmt->fetchColumn();

        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare('SELECT id, product_id, qty, status, restocked FROM orders WHERE order_code = ? FOR UPDATE');
            $stmt->execute([$orderCode]);
            $order = $stmt->fetch();
            if (!$order) {
                $pdo->rollBack();
                json_error('Order not found.', 404);
            }
            if ($order['restocked']) {
                $pdo->rollBack();
                json_error('This order has already been restocked.', 409);
            }
            if (!in_array($order['status'], RESTOCK_ELIGIBLE_STATUSES, true)) {
                $pdo->rollBack();
                json_error('Only cancelled, issue, or returned orders can be restocked.', 400);
            }
            if ($order['product_id']) {
                $pdo->prepare('UPDATE products SET qty = qty + ? WHERE id = ?')->execute([$order['qty'], $order['product_id']]);
            }
            $pdo->prepare('UPDATE orders SET restocked = 1, last_updated_by_name = ? WHERE id = ?')->execute([$adminName, $order['id']]);
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
        json_response(['ok' => true]);
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

    $stmt = $pdo->prepare('UPDATE orders SET status=?, rider=?, dispatch_note=?, delivery_fee=?, other_charges=?, charge_note=?, last_updated_by_name=? WHERE order_code=?');
    $stmt->execute([$status, $rider, $remark, $deliveryFee, $otherCharges, $chargeNote, $adminName, $orderCode]);

    if ($stmt->rowCount() === 0) {
        // rowCount 0 can also mean "matched but nothing changed" — confirm existence.
        $check = $pdo->prepare('SELECT 1 FROM orders WHERE order_code = ?');
        $check->execute([$orderCode]);
        if (!$check->fetchColumn()) {
            json_error('Order not found.', 404);
        }
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
