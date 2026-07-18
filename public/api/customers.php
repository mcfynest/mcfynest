<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/bootstrap_api.php';

$pdo = db();
$actor = require_admin();
require_admin_permission($pdo, $actor, 'customers');
$method = $_SERVER['REQUEST_METHOD'];

if ($method !== 'GET') {
    json_error('Method not allowed.', 405);
}

// Tracked by phone number across every store, independent of the
// 'orders' permission — this is its own permission-gated feature, and
// aggregates server-side (not client-side from a capped order list) so
// it stays accurate regardless of how many orders exist.
$q = str_field($_GET, 'q');

$sql = "SELECT
        o.phone,
        (SELECT o2.customer_name FROM orders o2 WHERE o2.phone = o.phone AND o2.deleted = 0 ORDER BY o2.created_at DESC LIMIT 1) AS name,
        GROUP_CONCAT(DISTINCT s.store_name ORDER BY s.store_name SEPARATOR ', ') AS stores,
        COUNT(*) AS order_count,
        SUM(o.amount) AS total_amount,
        MAX(o.created_at) AS last_order_at
    FROM orders o
    JOIN stores s ON s.id = o.store_id
    WHERE o.deleted = 0";
$params = [];

if ($q !== '') {
    $sql .= ' AND (o.phone LIKE ? OR o.customer_name LIKE ?)';
    $like = '%' . $q . '%';
    $params[] = $like;
    $params[] = $like;
}

$sql .= ' GROUP BY o.phone ORDER BY order_count DESC, last_order_at DESC LIMIT 500';

$stmt = $pdo->prepare($sql);
$stmt->execute($params);

$customers = array_map(function ($c) {
    return [
        'phone' => $c['phone'],
        'name' => $c['name'],
        'stores' => $c['stores'],
        'orderCount' => (int) $c['order_count'],
        'totalAmount' => (float) $c['total_amount'],
        'lastOrderAt' => strtotime($c['last_order_at']) * 1000,
        'repeat' => (int) $c['order_count'] > 1,
    ];
}, $stmt->fetchAll());

json_response(['customers' => $customers]);
