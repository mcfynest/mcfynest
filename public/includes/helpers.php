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
