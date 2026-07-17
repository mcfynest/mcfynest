<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/bootstrap_api.php';

$actor = current_actor();
$out = null;
if ($actor && $actor['type'] === 'store') {
    $pdo = db();
    $stmt = $pdo->prepare('SELECT position FROM stores WHERE id = ?');
    $stmt->execute([$actor['row_id']]);
    $out = [
        'type' => 'store',
        'store_id' => $actor['store_id'],
        'store_name' => $actor['store_name'],
        'role' => $actor['role'],
        'is_primary' => $actor['role'] === 'owner',
        'position' => $stmt->fetchColumn() ?: null,
        'permissions' => store_permissions($pdo, $actor),
    ];
} elseif ($actor && $actor['type'] === 'admin') {
    $pdo = db();
    $stmt = $pdo->prepare('SELECT position FROM admin_accounts WHERE id = ?');
    $stmt->execute([$actor['row_id']]);
    $out = [
        'type' => 'admin',
        'admin_id' => $actor['admin_id'],
        'name' => $actor['name'],
        'position' => $stmt->fetchColumn() ?: null,
        'permissions' => admin_permissions($pdo, $actor),
    ];
}

json_response([
    'csrf_token' => csrf_token(),
    'actor' => $out,
    'app_name' => defined('APP_NAME') ? APP_NAME : 'Manifest',
    'currency' => defined('APP_CURRENCY_SYMBOL') ? APP_CURRENCY_SYMBOL : '₦',
]);
