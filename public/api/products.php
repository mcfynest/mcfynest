<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/bootstrap_api.php';

$pdo = db();
$actor = require_actor();
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    if ($actor['type'] === 'admin') {
        $storeFilter = str_field($_GET, 'store_id');
        $sql = 'SELECT p.id, p.name, p.qty, p.created_at, s.store_name, s.store_id
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

    // Store actor (owner or agent)
    $stmt = $pdo->prepare('SELECT id, name, qty, created_at FROM products WHERE store_id = ? ORDER BY name');
    $stmt->execute([$actor['owner_row_id']]);
    $products = $stmt->fetchAll();

    if ($actor['role'] === 'agent') {
        $allowed = array_flip(agent_product_ids($pdo, $actor['row_id']));
        $products = array_values(array_filter($products, fn($p) => isset($allowed[(int) $p['id']])));
    }

    json_response(['products' => $products]);
}

if ($method === 'POST') {
    // Only a store owner logs stock drop-offs.
    if ($actor['type'] !== 'store' || $actor['role'] !== 'owner') {
        json_error('Only a store owner can log stock drop-offs.', 403);
    }
    $body = read_json_body();
    $name = str_field($body, 'name');
    $qty = (int) num_field($body, 'qty', -1);

    if ($name === '' || $qty < 0) {
        json_error('Enter a product name and a valid quantity.', 400);
    }

    $stmt = $pdo->prepare('INSERT INTO products (store_id, name, qty) VALUES (?, ?, ?)');
    $stmt->execute([$actor['row_id'], $name, $qty]);

    json_response(['id' => (int) $pdo->lastInsertId(), 'name' => $name, 'qty' => $qty], 201);
}

if ($method === 'PATCH') {
    if ($actor['type'] !== 'store' || $actor['role'] !== 'owner') {
        json_error('Only a store owner can adjust stock.', 403);
    }
    $body = read_json_body();
    $id = (int) ($body['id'] ?? 0);
    $delta = (int) num_field($body, 'delta', 0);

    if ($id <= 0 || $delta === 0) {
        json_error('Nothing to update.', 400);
    }

    // Ownership check happens in the WHERE clause — a store can only ever
    // touch its own products, enforced here server-side.
    $stmt = $pdo->prepare('UPDATE products SET qty = GREATEST(0, qty + ?) WHERE id = ? AND store_id = ?');
    $stmt->execute([$delta, $id, $actor['row_id']]);

    if ($stmt->rowCount() === 0) {
        json_error('Product not found.', 404);
    }

    $stmt = $pdo->prepare('SELECT qty FROM products WHERE id = ?');
    $stmt->execute([$id]);
    json_response(['id' => $id, 'qty' => (int) $stmt->fetchColumn()]);
}

json_error('Method not allowed.', 405);
