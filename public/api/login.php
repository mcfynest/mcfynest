<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/bootstrap_api.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Method not allowed.', 405);
}

$body = read_json_body();
$mode = str_field($body, 'mode');
$id = str_field($body, 'id');
$password = (string) ($body['password'] ?? '');

if ($id === '' || $password === '') {
    json_error('Enter an ID and password.', 400);
}

$pdo = db();

if ($mode === 'admin') {
    $row = login_admin($pdo, $id, $password);
    $actor = ['type' => 'admin', 'row_id' => (int) $row['id']];
    json_response([
        'csrf_token' => csrf_token(),
        'actor' => [
            'type' => 'admin',
            'admin_id' => $row['admin_id'],
            'name' => $row['name'],
            'position' => $row['position'] ?: null,
            'permissions' => admin_permissions($pdo, $actor),
        ],
    ]);
}

if ($mode === 'store') {
    $row = login_store($pdo, $id, $password);
    $actor = ['type' => 'store', 'row_id' => (int) $row['id'], 'role' => $row['role']];
    json_response([
        'csrf_token' => csrf_token(),
        'actor' => [
            'type' => 'store',
            'store_id' => $row['store_id'],
            'store_name' => $row['store_name'],
            'role' => $row['role'],
            'is_primary' => $row['role'] === 'owner',
            'position' => $row['position'] ?: null,
            'permissions' => store_permissions($pdo, $actor),
        ],
    ]);
}

json_error('Unknown login mode.', 400);
