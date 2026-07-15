<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/bootstrap_api.php';

$pdo = db();
$actor = require_store_owner();
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $stmt = $pdo->prepare('SELECT id, store_id, created_at FROM stores WHERE parent_store_id = ? AND role = "agent" AND is_active = 1 ORDER BY created_at DESC');
    $stmt->execute([$actor['row_id']]);
    $agents = $stmt->fetchAll();

    $out = [];
    foreach ($agents as $a) {
        $stmt2 = $pdo->prepare('SELECT p.id, p.name FROM agent_products ap JOIN products p ON p.id = ap.product_id WHERE ap.agent_store_id = ? ORDER BY p.name');
        $stmt2->execute([$a['id']]);
        $out[] = [
            'id' => (int) $a['id'],
            'store_id' => $a['store_id'],
            'products' => $stmt2->fetchAll(),
        ];
    }
    json_response(['agents' => $out]);
}

if ($method === 'POST') {
    $body = read_json_body();
    $password = (string) ($body['password'] ?? '');
    $productIds = array_map('intval', $body['product_ids'] ?? []);

    if ($password === '' || strlen($password) < 6) {
        json_error('Set a password of at least 6 characters.', 400);
    }

    // Only allow assigning products that actually belong to this owner's store.
    $validProductIds = [];
    if (!empty($productIds)) {
        $placeholders = implode(',', array_fill(0, count($productIds), '?'));
        $stmt = $pdo->prepare("SELECT id FROM products WHERE store_id = ? AND id IN ($placeholders)");
        $stmt->execute(array_merge([$actor['row_id']], $productIds));
        $validProductIds = array_map('intval', array_column($stmt->fetchAll(), 'id'));
    }

    $storeId = generate_unique_code($actor['store_name'], function ($code) use ($pdo) {
        $s = $pdo->prepare('SELECT 1 FROM stores WHERE store_id = ?');
        $s->execute([$code]);
        return (bool) $s->fetchColumn();
    });

    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare('INSERT INTO stores (store_id, store_name, password_hash, role, parent_store_id) VALUES (?, ?, ?, "agent", ?)');
        $stmt->execute([$storeId, $actor['store_name'], password_hash($password, PASSWORD_BCRYPT), $actor['row_id']]);
        $agentRowId = (int) $pdo->lastInsertId();

        if (!empty($validProductIds)) {
            $ins = $pdo->prepare('INSERT INTO agent_products (agent_store_id, product_id) VALUES (?, ?)');
            foreach ($validProductIds as $pid) {
                $ins->execute([$agentRowId, $pid]);
            }
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }

    json_response(['store_id' => $storeId, 'password' => $password], 201);
}

if ($method === 'PATCH') {
    $body = read_json_body();
    $agentId = (int) ($body['id'] ?? 0);

    $stmt = $pdo->prepare('SELECT id FROM stores WHERE id = ? AND parent_store_id = ? AND role = "agent"');
    $stmt->execute([$agentId, $actor['row_id']]);
    if (!$stmt->fetchColumn()) {
        json_error('Team member not found.', 404);
    }

    $response = ['id' => $agentId];

    if (array_key_exists('product_ids', $body)) {
        $productIds = array_map('intval', $body['product_ids'] ?? []);
        $validProductIds = [];
        if (!empty($productIds)) {
            $placeholders = implode(',', array_fill(0, count($productIds), '?'));
            $s = $pdo->prepare("SELECT id FROM products WHERE store_id = ? AND id IN ($placeholders)");
            $s->execute(array_merge([$actor['row_id']], $productIds));
            $validProductIds = array_map('intval', array_column($s->fetchAll(), 'id'));
        }
        $pdo->prepare('DELETE FROM agent_products WHERE agent_store_id = ?')->execute([$agentId]);
        if (!empty($validProductIds)) {
            $ins = $pdo->prepare('INSERT INTO agent_products (agent_store_id, product_id) VALUES (?, ?)');
            foreach ($validProductIds as $pid) {
                $ins->execute([$agentId, $pid]);
            }
        }
    }

    if (!empty($body['new_password'])) {
        $newPassword = (string) $body['new_password'];
        if (strlen($newPassword) < 6) {
            json_error('New password must be at least 6 characters.', 400);
        }
        $pdo->prepare('UPDATE stores SET password_hash = ? WHERE id = ?')->execute([password_hash($newPassword, PASSWORD_BCRYPT), $agentId]);
        $response['new_password'] = $newPassword;
    }

    json_response($response);
}

if ($method === 'DELETE') {
    $body = read_json_body();
    $agentId = (int) ($body['id'] ?? 0);

    $stmt = $pdo->prepare('UPDATE stores SET is_active = 0 WHERE id = ? AND parent_store_id = ? AND role = "agent"');
    $stmt->execute([$agentId, $actor['row_id']]);

    if ($stmt->rowCount() === 0) {
        json_error('Team member not found.', 404);
    }
    json_response(['ok' => true]);
}

json_error('Method not allowed.', 405);
