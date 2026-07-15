<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/bootstrap_api.php';

$pdo = db();
require_admin();
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $countStmt = $pdo->query('SELECT COUNT(*) FROM orders WHERE seen_by_admin = 0');
    $count = (int) $countStmt->fetchColumn();

    $full = str_field($_GET, 'full') === '1';
    if (!$full) {
        json_response(['count' => $count]);
    }

    $stmt = $pdo->query('SELECT o.order_code, o.product_name, o.customer_name, o.phone, o.created_at, s.store_name
        FROM orders o JOIN stores s ON s.id = o.store_id
        WHERE o.seen_by_admin = 0 ORDER BY o.created_at DESC LIMIT 100');
    $orders = array_map(function ($o) {
        return [
            'id' => $o['order_code'],
            'store' => $o['store_name'],
            'item' => $o['product_name'],
            'customer' => $o['customer_name'],
            'phone' => $o['phone'],
            'createdAt' => strtotime($o['created_at']) * 1000,
        ];
    }, $stmt->fetchAll());

    json_response(['count' => $count, 'orders' => $orders]);
}

if ($method === 'POST') {
    $body = read_json_body();
    if (($body['action'] ?? '') !== 'mark_seen') {
        json_error('Unknown action.', 400);
    }
    $pdo->exec('UPDATE orders SET seen_by_admin = 1 WHERE seen_by_admin = 0');
    json_response(['ok' => true, 'count' => 0]);
}

json_error('Method not allowed.', 405);
