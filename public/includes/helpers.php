<?php
declare(strict_types=1);

if (!defined('MANIFEST_ENTRY')) {
    http_response_code(403);
    exit('Forbidden');
}

function json_response($data, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function json_error(string $message, int $status = 400): void
{
    json_response(['error' => $message], $status);
}

function read_json_body(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        return [];
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function str_field(array $body, string $key, string $default = ''): string
{
    $v = $body[$key] ?? $default;
    return is_string($v) ? trim($v) : $default;
}

function num_field(array $body, string $key, float $default = 0): float
{
    $v = $body[$key] ?? $default;
    if (is_numeric($v)) {
        return (float) $v;
    }
    return $default;
}

/**
 * Generate a short unique code like AMK-4821 from a name, retrying on
 * collision against the given "SELECT 1 FROM table WHERE col = ?" check.
 */
function generate_unique_code(string $seed, callable $existsCheck): string
{
    $prefix = strtoupper(preg_replace('/[^A-Za-z]/', '', $seed));
    $prefix = substr($prefix, 0, 3);
    $prefix = str_pad($prefix === '' ? 'STR' : $prefix, 3, 'X');

    for ($i = 0; $i < 25; $i++) {
        $code = $prefix . '-' . random_int(1000, 9999);
        if (!$existsCheck($code)) {
            return $code;
        }
    }
    // Extremely unlikely fallback.
    return $prefix . '-' . bin2hex(random_bytes(3));
}

function generate_order_code(PDO $pdo): string
{
    for ($i = 0; $i < 25; $i++) {
        $code = 'WB' . strtoupper(bin2hex(random_bytes(3)));
        $stmt = $pdo->prepare('SELECT 1 FROM orders WHERE order_code = ?');
        $stmt->execute([$code]);
        if (!$stmt->fetchColumn()) {
            return $code;
        }
    }
    return 'WB' . strtoupper(bin2hex(random_bytes(5)));
}

function money(?float $n): string
{
    $n = $n ?? 0;
    if ($n == 0) {
        return '';
    }
    return APP_CURRENCY_SYMBOL . number_format($n, 0);
}

/**
 * A store's wallet balance: sum of (amount - deliveryFee - otherCharges)
 * over its delivered orders, minus whatever is currently reserved by
 * pending or already-paid withdrawal requests. Always computed live from
 * source rows — never cached/stored redundantly — so it can't drift out
 * of sync with the orders/withdrawals it's derived from.
 */
function store_delivered_total(PDO $pdo, int $ownerRowId): float
{
    $stmt = $pdo->prepare("SELECT COALESCE(SUM(amount - delivery_fee - other_charges), 0) FROM orders WHERE store_id = ? AND status = 'delivered'");
    $stmt->execute([$ownerRowId]);
    return (float) $stmt->fetchColumn();
}

function store_reserved_total(PDO $pdo, int $ownerRowId): float
{
    $stmt = $pdo->prepare("SELECT COALESCE(SUM(amount), 0) FROM withdrawals WHERE store_id = ? AND status IN ('pending','paid')");
    $stmt->execute([$ownerRowId]);
    return (float) $stmt->fetchColumn();
}

function store_available_balance(PDO $pdo, int $ownerRowId): float
{
    return max(0.0, store_delivered_total($pdo, $ownerRowId) - store_reserved_total($pdo, $ownerRowId));
}

function store_requested_withdrawal_today(PDO $pdo, int $ownerRowId): bool
{
    $stmt = $pdo->prepare("SELECT 1 FROM withdrawals WHERE store_id = ? AND DATE(requested_at) = CURDATE() LIMIT 1");
    $stmt->execute([$ownerRowId]);
    return (bool) $stmt->fetchColumn();
}

/**
 * Appends inclusive date_from/date_to bounds (YYYY-MM-DD strings) on a
 * DATETIME or DATE column to a WHERE clause already ending in "1=1" or
 * a prior condition. Reads date_from/date_to straight from $_GET.
 */
function apply_date_range(string &$sql, array &$params, string $column, bool $isDateOnly = false): void
{
    $from = str_field($_GET, 'date_from');
    $to = str_field($_GET, 'date_to');
    if ($from !== '' && preg_match('/^\d{4}-\d{2}-\d{2}$/', $from)) {
        $sql .= " AND {$column} >= ?";
        $params[] = $isDateOnly ? $from : $from . ' 00:00:00';
    }
    if ($to !== '' && preg_match('/^\d{4}-\d{2}-\d{2}$/', $to)) {
        $sql .= " AND {$column} <= ?";
        $params[] = $isDateOnly ? $to : $to . ' 23:59:59';
    }
}
