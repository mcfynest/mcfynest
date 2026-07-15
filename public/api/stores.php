<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/bootstrap_api.php';

$pdo = db();
$actor = require_admin();
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $stmt = $pdo->query('SELECT s.id, s.store_id, s.store_name, s.role, s.created_at, owner.store_name AS owner_name
        FROM stores s LEFT JOIN stores owner ON owner.id = s.parent_store_id
        WHERE s.is_active = 1
        ORDER BY s.role = "agent", s.store_name, s.created_at DESC');
    json_response(['accounts' => $stmt->fetchAll()]);
}

if ($method === 'POST') {
    $body = read_json_body();
    $storeName = str_field($body, 'store_name');
    $password = (string) ($body['password'] ?? '');

    if ($storeName === '' || strlen($password) < 6) {
        json_error('Enter a store name and a password of at least 6 characters.', 400);
    }

    $storeId = generate_unique_code($storeName, function ($code) use ($pdo) {
        $s = $pdo->prepare('SELECT 1 FROM stores WHERE store_id = ?');
        $s->execute([$code]);
        return (bool) $s->fetchColumn();
    });

    $stmt = $pdo->prepare('INSERT INTO stores (store_id, store_name, password_hash, role) VALUES (?, ?, ?, "owner")');
    $stmt->execute([$storeId, $storeName, password_hash($password, PASSWORD_BCRYPT)]);

    json_response(['store_id' => $storeId, 'password' => $password], 201);
}

if ($method === 'PATCH') {
    $body = read_json_body();
    $rowId = (int) ($body['id'] ?? 0);
    $newPassword = (string) ($body['new_password'] ?? '');

    if ($rowId <= 0 || strlen($newPassword) < 6) {
        json_error('New password must be at least 6 characters.', 400);
    }

    $stmt = $pdo->prepare('UPDATE stores SET password_hash = ? WHERE id = ?');
    $stmt->execute([password_hash($newPassword, PASSWORD_BCRYPT), $rowId]);
    if ($stmt->rowCount() === 0) {
        json_error('Account not found.', 404);
    }
    json_response(['id' => $rowId, 'new_password' => $newPassword]);
}

if ($method === 'DELETE') {
    $body = read_json_body();
    $rowId = (int) ($body['id'] ?? 0);

    $stmt = $pdo->prepare('UPDATE stores SET is_active = 0 WHERE id = ?');
    $stmt->execute([$rowId]);
    if ($stmt->rowCount() === 0) {
        json_error('Account not found.', 404);
    }
    json_response(['ok' => true]);
}

json_error('Method not allowed.', 405);
