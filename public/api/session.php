<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/bootstrap_api.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    json_error('Method not allowed.', 405);
}

$actor = current_actor();
$out = null;
if ($actor && $actor['type'] === 'store') {
    $out = [
        'type' => 'store',
        'store_id' => $actor['store_id'],
        'store_name' => $actor['store_name'],
        'role' => $actor['role'],
        'is_primary' => $actor['role'] === 'owner',
    ];
} elseif ($actor && $actor['type'] === 'admin') {
    $out = [
        'type' => 'admin',
        'admin_id' => $actor['admin_id'],
        'name' => $actor['name'],
    ];
}

json_response([
    'csrf_token' => csrf_token(),
    'actor' => $out,
    'app_name' => defined('APP_NAME') ? APP_NAME : 'Manifest',
    'currency' => defined('APP_CURRENCY_SYMBOL') ? APP_CURRENCY_SYMBOL : '₦',
]);
