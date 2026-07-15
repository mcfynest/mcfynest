<?php
declare(strict_types=1);

if (!defined('MANIFEST_ENTRY')) {
    http_response_code(403);
    exit('Forbidden');
}

const MAX_LOGIN_ATTEMPTS = 8;
const LOCKOUT_MINUTES = 10;

/**
 * Returns the logged-in actor from the session, or null.
 *
 * Store owner:  ['type'=>'store','row_id'=>.., 'store_id'=>.., 'store_name'=>.., 'role'=>'owner']
 * Store agent:  ['type'=>'store','row_id'=>.., 'store_id'=>.., 'store_name'=>.., 'role'=>'agent', 'owner_row_id'=>..]
 * Admin:        ['type'=>'admin','row_id'=>.., 'admin_id'=>.., 'name'=>..]
 */
function current_actor(): ?array
{
    if (($_SESSION['actor_type'] ?? '') === 'store') {
        return [
            'type' => 'store',
            'row_id' => (int) $_SESSION['store_row_id'],
            'store_id' => $_SESSION['store_id'],
            'store_name' => $_SESSION['store_name'],
            'role' => $_SESSION['store_role'],
            'owner_row_id' => (int) ($_SESSION['owner_row_id'] ?? $_SESSION['store_row_id']),
        ];
    }
    if (($_SESSION['actor_type'] ?? '') === 'admin') {
        return [
            'type' => 'admin',
            'row_id' => (int) $_SESSION['admin_row_id'],
            'admin_id' => $_SESSION['admin_id'],
            'name' => $_SESSION['admin_name'],
        ];
    }
    return null;
}

function require_actor(): array
{
    $actor = current_actor();
    if (!$actor) {
        json_error('Not logged in.', 401);
    }
    return $actor;
}

function require_admin(): array
{
    $actor = require_actor();
    if ($actor['type'] !== 'admin') {
        json_error('Admin access only.', 403);
    }
    return $actor;
}

function require_store(): array
{
    $actor = require_actor();
    if ($actor['type'] !== 'store') {
        json_error('Store access only.', 403);
    }
    return $actor;
}

function require_store_owner(): array
{
    $actor = require_store();
    if ($actor['role'] !== 'owner') {
        json_error('Only the store owner can do this.', 403);
    }
    return $actor;
}

/** Product IDs an agent is restricted to. Always re-read from DB — never trust the session cache. */
function agent_product_ids(PDO $pdo, int $agentRowId): array
{
    $stmt = $pdo->prepare('SELECT product_id FROM agent_products WHERE agent_store_id = ?');
    $stmt->execute([$agentRowId]);
    return array_map('intval', array_column($stmt->fetchAll(), 'product_id'));
}

function is_locked(?string $lockedUntil): bool
{
    return $lockedUntil !== null && strtotime($lockedUntil) > time();
}

function register_failed_login(PDO $pdo, string $table, int $id, int $currentFailed): void
{
    $failed = $currentFailed + 1;
    $lockUntil = null;
    if ($failed >= MAX_LOGIN_ATTEMPTS) {
        $lockUntil = date('Y-m-d H:i:s', time() + LOCKOUT_MINUTES * 60);
        $failed = 0;
    }
    $stmt = $pdo->prepare("UPDATE {$table} SET failed_logins = ?, locked_until = ? WHERE id = ?");
    $stmt->execute([$failed, $lockUntil, $id]);
}

function reset_failed_login(PDO $pdo, string $table, int $id): void
{
    $stmt = $pdo->prepare("UPDATE {$table} SET failed_logins = 0, locked_until = NULL WHERE id = ?");
    $stmt->execute([$id]);
}

function login_store(PDO $pdo, string $storeId, string $password): array
{
    $stmt = $pdo->prepare('SELECT * FROM stores WHERE store_id = ? AND is_active = 1');
    $stmt->execute([strtoupper($storeId)]);
    $row = $stmt->fetch();

    if (!$row) {
        // Constant-time-ish: still run a hash verify against a dummy hash to avoid
        // trivially distinguishing "no such ID" from "wrong password" via timing.
        password_verify($password, '$2y$10$abcdefghijklmnopqrstuuC5s5s5s5s5s5s5s5s5s5s5s5s5s5s5');
        json_error('Wrong Store ID or password. Ask your dispatcher to check it.', 401);
    }

    if (is_locked($row['locked_until'])) {
        json_error('Too many failed attempts. Try again in a few minutes.', 429);
    }

    if (!password_verify($password, $row['password_hash'])) {
        register_failed_login($pdo, 'stores', (int) $row['id'], (int) $row['failed_logins']);
        json_error('Wrong Store ID or password. Ask your dispatcher to check it.', 401);
    }

    reset_failed_login($pdo, 'stores', (int) $row['id']);

    session_regenerate_id(true);
    $_SESSION['actor_type'] = 'store';
    $_SESSION['store_row_id'] = (int) $row['id'];
    $_SESSION['store_id'] = $row['store_id'];
    $_SESSION['store_name'] = $row['store_name'];
    $_SESSION['store_role'] = $row['role'];
    $_SESSION['owner_row_id'] = $row['role'] === 'agent' ? (int) $row['parent_store_id'] : (int) $row['id'];

    return $row;
}

function login_admin(PDO $pdo, string $adminId, string $password): array
{
    $stmt = $pdo->prepare('SELECT * FROM admin_accounts WHERE admin_id = ? AND is_active = 1');
    $stmt->execute([strtoupper($adminId)]);
    $row = $stmt->fetch();

    if (!$row) {
        password_verify($password, '$2y$10$abcdefghijklmnopqrstuuC5s5s5s5s5s5s5s5s5s5s5s5s5s5s5');
        json_error('Wrong admin ID or password.', 401);
    }

    if (is_locked($row['locked_until'])) {
        json_error('Too many failed attempts. Try again in a few minutes.', 429);
    }

    if (!password_verify($password, $row['password_hash'])) {
        register_failed_login($pdo, 'admin_accounts', (int) $row['id'], (int) $row['failed_logins']);
        json_error('Wrong admin ID or password.', 401);
    }

    reset_failed_login($pdo, 'admin_accounts', (int) $row['id']);

    session_regenerate_id(true);
    $_SESSION['actor_type'] = 'admin';
    $_SESSION['admin_row_id'] = (int) $row['id'];
    $_SESSION['admin_id'] = $row['admin_id'];
    $_SESSION['admin_name'] = $row['name'];

    return $row;
}

function logout_actor(): void
{
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $params = session_get_cookie_params();
        setcookie(session_name(), '', time() - 42000, $params['path'], $params['domain'], $params['secure'], $params['httponly']);
    }
    session_destroy();
}
