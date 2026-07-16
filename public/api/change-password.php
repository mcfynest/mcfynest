<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/bootstrap_api.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Method not allowed.', 405);
}

$pdo = db();
$actor = require_actor();

$body = read_json_body();
$newPassword = (string) ($body['new_password'] ?? '');
$confirm = (string) ($body['confirm'] ?? '');

if (strlen($newPassword) < 6) {
    json_error('New password must be at least 6 characters.', 400);
}
if ($newPassword !== $confirm) {
    json_error('Passwords do not match.', 400);
}

if ($actor['type'] === 'admin') {
    $pdo->prepare('UPDATE admin_accounts SET password_hash = ? WHERE id = ?')
        ->execute([password_hash($newPassword, PASSWORD_BCRYPT), $actor['row_id']]);
} else {
    $pdo->prepare('UPDATE stores SET password_hash = ? WHERE id = ?')
        ->execute([password_hash($newPassword, PASSWORD_BCRYPT), $actor['row_id']]);
}

json_response(['ok' => true]);
