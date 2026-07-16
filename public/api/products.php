<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/bootstrap_api.php';

$pdo = db();
$actor = require_actor();
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    if ($actor['type'] === 'admin') {
        require_admin_permission($pdo, $actor, 'inventory');
        $storeFilter = str_field($_GET, 'store_id');
        $sql = 'SELECT p.id, p.name, p.qty, p.dropped_off_at, p.created_at, s.store_name, s.store_id
                FROM products p JOIN stores s ON s.id = p.store_id';
        $params = [];
        if ($storeFilter !== '' && $storeFilter !== 'all') {
            $sql .= ' WHERE s.store_id = ?';
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
    $stmt = $pdo->prepare('SELECT id, name, qty, dropped_off_at, created_at FROM products WHERE store_id = ? ORDER BY name');
    $stmt->execute([$actor['owner_row_id']]);
    json_response(['products' => $stmt->fetchAll()]);
}

if ($method === 'POST') {
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
    if ($actor['type'] !== 'store') {
        json_error('Only a store can adjust stock.', 403);
    }
    require_store_permission($pdo, $actor, 'inventory');

    $body = read_json_body();
    $id = (int) ($body['id'] ?? 0);
    $delta = (int) num_field($body, 'delta', 0);

    if ($id <= 0 || $delta === 0) {
        json_error('Nothing to update.', 400);
    }

    // Ownership check happens in the WHERE clause — a store can only ever
    // touch its own store's products, enforced here server-side.
    $stmt = $pdo->prepare('UPDATE products SET qty = GREATEST(0, qty + ?) WHERE id = ? AND store_id = ?');
    $stmt->execute([$delta, $id, $actor['owner_row_id']]);

    if ($stmt->rowCount() === 0) {
        json_error('Product not found.', 404);
    }

    $stmt = $pdo->prepare('SELECT qty FROM products WHERE id = ?');
    $stmt->execute([$id]);
    json_response(['id' => $id, 'qty' => (int) $stmt->fetchColumn()]);
}

json_error('Method not allowed.', 405);
