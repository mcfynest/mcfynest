<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/bootstrap_api.php';

$pdo = db();
$actor = require_admin();
require_admin_permission($pdo, $actor, 'team');
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $stmt = $pdo->query('SELECT id, admin_id, name, position, permissions, created_at FROM admin_accounts WHERE is_active = 1 ORDER BY created_at ASC');
    $rows = $stmt->fetchAll();
    $out = array_map(function ($a) {
        $decoded = $a['permissions'] ? json_decode($a['permissions'], true) : [];
        return [
            'id' => (int) $a['id'],
            'admin_id' => $a['admin_id'],
            'name' => $a['name'],
            'position' => $a['position'] ?: null,
            'permissions' => is_array($decoded) ? $decoded : [],
        ];
    }, $rows);
    json_response(['admins' => $out]);
}

if ($method === 'POST') {
    $body = read_json_body();
    $name = str_field($body, 'name');
    $position = str_field($body, 'position');
    $password = (string) ($body['password'] ?? '');
    $checkedPerms = array_map('strval', $body['permissions'] ?? []);
    $permissions = build_permissions($checkedPerms, ADMIN_PERM_KEYS);

    if ($name === '' || strlen($password) < 6) {
        json_error('Enter a name and a password of at least 6 characters.', 400);
    }

    $adminId = generate_unique_code('ADM', function ($code) use ($pdo) {
        $s = $pdo->prepare('SELECT 1 FROM admin_accounts WHERE admin_id = ?');
        $s->execute([$code]);
        return (bool) $s->fetchColumn();
    });

    $stmt = $pdo->prepare('INSERT INTO admin_accounts (admin_id, name, position, password_hash, permissions) VALUES (?, ?, ?, ?, ?)');
    $stmt->execute([$adminId, $name, $position ?: null, password_hash($password, PASSWORD_BCRYPT), json_encode($permissions)]);

    json_response(['admin_id' => $adminId, 'password' => $password], 201);
}

if ($method === 'PATCH') {
    $body = read_json_body();
    $rowId = (int) ($body['id'] ?? 0);
    $newPassword = (string) ($body['new_password'] ?? '');

    if ($rowId <= 0 || strlen($newPassword) < 6) {
        json_error('New password must be at least 6 characters.', 400);
    }

    $stmt = $pdo->prepare('UPDATE admin_accounts SET password_hash = ? WHERE id = ? AND is_active = 1');
    $stmt->execute([password_hash($newPassword, PASSWORD_BCRYPT), $rowId]);
    if ($stmt->rowCount() === 0) {
        json_error('Admin login not found.', 404);
    }
    json_response(['id' => $rowId, 'new_password' => $newPassword]);
}

if ($method === 'DELETE') {
    $body = read_json_body();
    $rowId = (int) ($body['id'] ?? 0);

    $pdo->beginTransaction();
    try {
        // Lock every active admin row so a concurrent removal can't race
        // past this count check and leave zero admin logins.
        $pdo->query('SELECT id FROM admin_accounts WHERE is_active = 1 FOR UPDATE');
        $countStmt = $pdo->query('SELECT COUNT(*) FROM admin_accounts WHERE is_active = 1');
        if ((int) $countStmt->fetchColumn() <= 1) {
            $pdo->rollBack();
            json_error('Cannot remove the only admin login.', 400);
        }

        $stmt = $pdo->prepare('UPDATE admin_accounts SET is_active = 0 WHERE id = ? AND is_active = 1');
        $stmt->execute([$rowId]);
        if ($stmt->rowCount() === 0) {
            $pdo->rollBack();
            json_error('Admin login not found.', 404);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
    json_response(['ok' => true]);
}

json_error('Method not allowed.', 405);
