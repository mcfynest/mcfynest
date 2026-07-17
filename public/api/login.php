<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/bootstrap_api.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Method not allowed.', 405);
}

$body = read_json_body();
$id = str_field($body, 'id');
$password = (string) ($body['password'] ?? '');

if ($id === '' || $password === '') {
    json_error('Enter an ID and password.', 400);
}

$pdo = db();
$idUpper = strtoupper($id);

// Unified login: try admin first, then store
$adminRow = null;
$storeRow = null;

$stmtAdmin = $pdo->prepare('SELECT * FROM admin_accounts WHERE admin_id = ? AND is_active = 1');
$stmtAdmin->execute([$idUpper]);
$adminRow = $stmtAdmin->fetch();

if (!$adminRow) {
    $stmtStore = $pdo->prepare('SELECT * FROM stores WHERE store_id = ? AND is_active = 1');
    $stmtStore->execute([$idUpper]);
    $storeRow = $stmtStore->fetch();
}

// Neither admin nor store found
if (!$adminRow && !$storeRow) {
    password_verify($password, '$2y$10$abcdefghijklmnopqrstuuC5s5s5s5s5s5s5s5s5s5s5s5s5s5s5');
    json_error('Wrong ID or password.', 401);
}

// Admin login
if ($adminRow) {
    if (is_locked($adminRow['locked_until'])) {
        json_error('Too many failed attempts. Try again in a few minutes.', 429);
    }
    if (!password_verify($password, $adminRow['password_hash'])) {
        register_failed_login($pdo, 'admin_accounts', (int) $adminRow['id'], (int) $adminRow['failed_logins']);
        json_error('Wrong ID or password.', 401);
    }
    reset_failed_login($pdo, 'admin_accounts', (int) $adminRow['id']);

    session_regenerate_id(true);
    $_SESSION['actor_type'] = 'admin';
    $_SESSION['admin_row_id'] = (int) $adminRow['id'];
    $_SESSION['admin_id'] = $adminRow['admin_id'];
    $_SESSION['admin_name'] = $adminRow['name'];

    $actor = ['type' => 'admin', 'row_id' => (int) $adminRow['id']];
    json_response([
        'csrf_token' => csrf_token(),
        'actor' => [
            'type' => 'admin',
            'admin_id' => $adminRow['admin_id'],
            'name' => $adminRow['name'],
            'position' => $adminRow['position'] ?: null,
            'permissions' => admin_permissions($pdo, $actor),
        ],
    ]);
}

// Store login
if ($storeRow) {
    if (is_locked($storeRow['locked_until'])) {
        json_error('Too many failed attempts. Try again in a few minutes.', 429);
    }
    if (!password_verify($password, $storeRow['password_hash'])) {
        register_failed_login($pdo, 'stores', (int) $storeRow['id'], (int) $storeRow['failed_logins']);
        json_error('Wrong ID or password.', 401);
    }
    reset_failed_login($pdo, 'stores', (int) $storeRow['id']);

    session_regenerate_id(true);
    $_SESSION['actor_type'] = 'store';
    $_SESSION['store_row_id'] = (int) $storeRow['id'];
    $_SESSION['store_id'] = $storeRow['store_id'];
    $_SESSION['store_name'] = $storeRow['store_name'];
    $_SESSION['store_role'] = $storeRow['role'];
    $_SESSION['owner_row_id'] = $storeRow['role'] === 'agent' ? (int) $storeRow['parent_store_id'] : (int) $storeRow['id'];

    $actor = ['type' => 'store', 'row_id' => (int) $storeRow['id'], 'role' => $storeRow['role']];
    json_response([
        'csrf_token' => csrf_token(),
        'actor' => [
            'type' => 'store',
            'store_id' => $storeRow['store_id'],
            'store_name' => $storeRow['store_name'],
            'role' => $storeRow['role'],
            'is_primary' => $storeRow['role'] === 'owner',
            'position' => $storeRow['position'] ?: null,
            'permissions' => store_permissions($pdo, $actor),
        ],
    ]);
}
