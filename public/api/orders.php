<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/bootstrap_api.php';

$pdo = db();
$actor = require_actor();
$method = $_SERVER['REQUEST_METHOD'];

function order_row_for_client(array $o): array
{
    $delivery = (float) $o['delivery_fee'] + (float) $o['other_charges'];
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
    if ($actor['type'] === 'admin') {
        require_admin_permission($pdo, $actor, 'orders');
        $storeFilter = str_field($_GET, 'store_id');
        $statusFilter = str_field($_GET, 'status');
        $q = str_field($_GET, 'q');

        $sql = 'SELECT o.*, s.store_name, s.store_id AS store_login_id
                FROM orders o JOIN stores s ON s.id = o.store_id WHERE 1=1';
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
        apply_date_range($sql, $params, 'o.created_at');
        $sql .= ' ORDER BY o.created_at DESC LIMIT 1000';

        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        json_response(['orders' => array_map('order_row_for_client', $stmt->fetchAll())]);
    }

    // Store actor (owner or team member) — both see every order for
    // their store, gated only by the "history" permission.
    require_store_permission($pdo, $actor, 'history');
    $sql = 'SELECT o.*, s.store_name FROM orders o JOIN stores s ON s.id = o.store_id
            WHERE o.store_id = ?';
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
        $stmt = $pdo->prepare('SELECT id, name, qty FROM products WHERE id = ? AND store_id = ? FOR UPDATE');
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
    require_admin();
    require_admin_permission($pdo, $actor, 'orders');
    $body = read_json_body();
    $orderCode = str_field($body, 'id');
    if ($orderCode === '') {
        json_error('Missing order id.', 400);
    }

    $stmt = $pdo->prepare('SELECT name FROM admin_accounts WHERE id = ?');
    $stmt->execute([$actor['row_id']]);
    $adminName = (string) $stmt->fetchColumn();

    // Restock: a manual, one-time action on a cancelled/issue order — never automatic.
    if (($body['action'] ?? '') === 'restock') {
        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare("SELECT id, product_id, qty, status, restocked FROM orders WHERE order_code = ? FOR UPDATE");
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
            if (!in_array($order['status'], ['cancelled', 'issue'], true)) {
                $pdo->rollBack();
                json_error('Only cancelled or issue orders can be restocked.', 400);
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

    $validStatuses = ['pending', 'transit', 'delivered', 'issue', 'cancelled'];
    $status = str_field($body, 'status');
    if (!in_array($status, $validStatuses, true)) {
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

json_error('Method not allowed.', 405);
