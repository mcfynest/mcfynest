<?php
declare(strict_types=1);

if (!defined('MANIFEST_ENTRY')) {
    http_response_code(403);
    exit('Forbidden');
}

const MAX_LOGIN_ATTEMPTS = 8;
const LOCKOUT_MINUTES = 10;

// Canonical permission keys. Anything from a client request outside these
// lists is ignored when building a permissions object — never trust
// arbitrary JSON keys straight from the request body.
const STORE_TEAM_PERM_KEYS = ['order', 'inventory', 'history'];
const ADMIN_PERM_KEYS = ['orders', 'inventory', 'stores', 'team', 'withdrawals', 'expenses', 'trash'];

/** Builds a clean {key: bool} permissions object from a client-supplied list of checked keys. */
function build_permissions(array $checkedKeys, array $validKeys): array
{
    $checked = array_flip($checkedKeys);
    $out = [];
    foreach ($validKeys as $key) {
        $out[$key] = isset($checked[$key]);
    }
    return $out;
}

/** Full-access permissions object (used for store owners and the default admin). */
function all_permissions(array $validKeys): array
{
    return array_fill_keys($validKeys, true);
}

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

/**
 * Product IDs a team member's position is tagged as "primarily responsible
 * for." Reference-only — display purposes only, never used to restrict
 * access. A team member has full access to every product their store
 * holds, same as the owner; the only thing they can't do is manage the
 * team itself (see require_store_owner()).
 */
function agent_product_tags(PDO $pdo, int $agentRowId): array
{
    $stmt = $pdo->prepare('SELECT product_id FROM agent_products WHERE agent_store_id = ?');
    $stmt->execute([$agentRowId]);
    return array_map('intval', array_column($stmt->fetchAll(), 'product_id'));
}

/**
 * A store actor's effective permissions, always re-read from the database
 * — never cached in the session — so a permission an owner revokes takes
 * effect on the team member's very next request, not just their next
 * login. Owners always have full access.
 */
function store_permissions(PDO $pdo, array $actor): array
{
    if ($actor['role'] === 'owner') {
        return all_permissions(STORE_TEAM_PERM_KEYS);
    }
    $stmt = $pdo->prepare('SELECT permissions FROM stores WHERE id = ?');
    $stmt->execute([$actor['row_id']]);
    $raw = $stmt->fetchColumn();
    $decoded = $raw ? json_decode((string) $raw, true) : null;
    if (!is_array($decoded)) {
        // Fail closed: no readable permissions record means no access,
        // never silently grant everything.
        return array_fill_keys(STORE_TEAM_PERM_KEYS, false);
    }
    $out = [];
    foreach (STORE_TEAM_PERM_KEYS as $key) {
        $out[$key] = !empty($decoded[$key]);
    }
    return $out;
}

/** Same fresh-from-DB principle as store_permissions(), for admin logins. Report access is implicit and always on. */
function admin_permissions(PDO $pdo, array $actor): array
{
    $stmt = $pdo->prepare('SELECT permissions FROM admin_accounts WHERE id = ?');
    $stmt->execute([$actor['row_id']]);
    $raw = $stmt->fetchColumn();
    $decoded = $raw ? json_decode((string) $raw, true) : null;
    if (!is_array($decoded)) {
        return array_fill_keys(ADMIN_PERM_KEYS, false);
    }
    $out = [];
    foreach (ADMIN_PERM_KEYS as $key) {
        $out[$key] = !empty($decoded[$key]);
    }
    return $out;
}

function require_store_permission(PDO $pdo, array $actor, string $key): void
{
    $perms = store_permissions($pdo, $actor);
    if (empty($perms[$key])) {
        json_error('Your position does not have access to this.', 403);
    }
}

function require_admin_permission(PDO $pdo, array $actor, string $key): void
{
    $perms = admin_permissions($pdo, $actor);
    if (empty($perms[$key])) {
        json_error('Your admin login does not have access to this.', 403);
    }
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
