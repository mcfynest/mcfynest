<?php
declare(strict_types=1);

/**
 * POST /api/sheet-import.php — creates an order from a row a store typed
 * into its own Google Sheet (sent by the McFynest sheet-sync Apps Script
 * pasted into that Sheet).
 *
 * Unlike every other endpoint this one is called from outside the app,
 * so it deliberately does NOT load bootstrap_api.php: there is no
 * session or CSRF token here. The caller is identified solely by the
 * store's Sheet API key (stores.sheet_api_key), which is checked before
 * anything else in the request is looked at.
 *
 * Request JSON:  api_key, customer, phone, alt_phone?, product, qty,
 *                address, zone?, amount, notes?
 * Success (200): { "success": true, "order_id": "WB1A2B3C", "backorder": false }
 * Failure:       { "success": false, "error": "human-readable reason" }
 *                401 bad/missing key · 422 validation · 429 rate limit
 *
 * Order validation and creation go through create_order() — the exact
 * function the in-app Add Order form uses — so order rules live in one
 * place. The only checks done here are the ones specific to this
 * request shape: matching the typed product name to an inventory item,
 * and the amount being required on a Sheet row.
 *
 * Every request (success or failure) gets a row in sheet_import_log —
 * that's where to look when a store reports their sheet isn't syncing.
 */

define('MANIFEST_ENTRY', true);

require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/orders_lib.php';

$configPath = __DIR__ . '/../config/config.php';
if (file_exists($configPath)) {
    require_once $configPath;
}

const SHEET_RATE_LIMIT_PER_MINUTE = 60;
// An identical row from the same store within this window returns the
// order already created for it instead of creating a second one. The
// Sheet script can send the same row twice (an edit to the row while the
// first request is still in flight, or a retry after a timeout whose
// request actually got through), and a duplicate order would reserve
// stock and get dispatched twice.
const SHEET_DUPLICATE_WINDOW_SECONDS = 600;
const SHEET_LOG_RETENTION_DAYS = 90;
const SHEET_MAX_BODY_BYTES = 65536;
// Failed-key requests stop being logged per IP past this many in 10
// minutes, so a misbehaving caller can't flood the log table.
const SHEET_AUTH_FAIL_LOG_CAP = 50;

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

// Context for the log row written for this request.
$sheetCtx = ['store_id' => null, 'summary' => null, 'hash' => null];

function sheet_log(string $outcome, int $httpStatus, ?string $error = null, ?string $orderCode = null): void
{
    global $sheetCtx;
    try {
        db()->prepare('INSERT INTO sheet_import_log (store_id, ip, outcome, http_status, error_message, order_code, payload_hash, request_summary)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            ->execute([
                $sheetCtx['store_id'],
                substr((string) ($_SERVER['REMOTE_ADDR'] ?? ''), 0, 45),
                $outcome,
                $httpStatus,
                $error !== null ? mb_substr($error, 0, 500) : null,
                $orderCode,
                $sheetCtx['hash'],
                $sheetCtx['summary'],
            ]);
    } catch (Throwable $e) {
        // Logging must never turn into a failed response, but it must not
        // vanish silently either — fall back to the PHP error log.
        error_log('[manifest sheet-import] could not write sheet_import_log: ' . $e->getMessage() . " (outcome=$outcome, error=$error)");
    }
}

function sheet_fail(int $httpStatus, string $error, string $outcome): void
{
    sheet_log($outcome, $httpStatus, $error);
    json_response(['success' => false, 'error' => $error], $httpStatus);
}

/** Trimmed string value of a field; numbers are accepted and stringified (a phone typed as a number). */
function sheet_str(array $body, string $key): string
{
    $v = $body[$key] ?? null;
    if (is_string($v)) {
        return trim($v);
    }
    if (is_int($v) || is_float($v)) {
        return trim((string) $v);
    }
    return '';
}

set_exception_handler(function (Throwable $e): void {
    error_log('[manifest sheet-import] ' . $e->getMessage());
    sheet_log('server_error', 500, 'Server error: ' . $e->getMessage());
    json_response(['success' => false, 'error' => 'Something went wrong on the CRM side. Edit the row again to retry; if it keeps failing, contact McFynest.'], 500);
});
set_error_handler(function (int $severity, string $message, string $file, int $line): bool {
    if (!(error_reporting() & $severity)) {
        return false;
    }
    throw new ErrorException($message, 0, $severity, $file, $line);
});

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    // Not logged: nothing useful to diagnose, and crawlers would fill the log.
    json_response(['success' => false, 'error' => 'Method not allowed — use POST.'], 405);
}

$raw = (string) file_get_contents('php://input', false, null, 0, SHEET_MAX_BODY_BYTES + 1);
if (strlen($raw) > SHEET_MAX_BODY_BYTES) {
    json_response(['success' => false, 'error' => 'Request too large.'], 413);
}
$body = json_decode($raw, true);
if (!is_array($body)) {
    $body = [];
}

$pdo = db();

// ---------------------------------------------------------------------
// 1. Authenticate — before anything else in the request is examined, so
// an unauthenticated caller learns nothing about validation. Missing,
// malformed, unknown, regenerated-away, inactive-store and team-member
// keys all get the identical response.
// ---------------------------------------------------------------------
$apiKey = is_string($body['api_key'] ?? null) ? trim($body['api_key']) : '';
$store = null;
if (is_sheet_api_key_format($apiKey)) {
    $stmt = $pdo->prepare('SELECT id, store_name FROM stores WHERE sheet_api_key = ? AND role = "owner" AND is_active = 1');
    $stmt->execute([$apiKey]);
    $store = $stmt->fetch() ?: null;
}

$summaryFields = $body;
unset($summaryFields['api_key']);
$sheetCtx['summary'] = mb_substr((string) json_encode($summaryFields, JSON_UNESCAPED_UNICODE), 0, 2000);

if (!$store) {
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM sheet_import_log WHERE ip = ? AND outcome = "auth_failed" AND created_at > NOW() - INTERVAL 10 MINUTE');
    $stmt->execute([substr((string) ($_SERVER['REMOTE_ADDR'] ?? ''), 0, 45)]);
    if ((int) $stmt->fetchColumn() < SHEET_AUTH_FAIL_LOG_CAP) {
        // Record which key was tried only by its shape — enough to spot
        // "they never replaced the placeholder" without storing secrets.
        $hint = $apiKey === '' ? 'no key sent' : (is_sheet_api_key_format($apiKey) ? 'well-formed key not recognised (wrong, regenerated, or store removed)' : 'malformed key, starts "' . mb_substr($apiKey, 0, 12) . '"');
        sheet_log('auth_failed', 401, 'Invalid API key — ' . $hint);
    }
    json_response(['success' => false, 'error' => 'Invalid API key'], 401);
}

$storeRowId = (int) $store['id'];
$sheetCtx['store_id'] = $storeRowId;

// Occasional housekeeping so the log doesn't grow forever.
if (random_int(1, 100) === 1) {
    $pdo->exec('DELETE FROM sheet_import_log WHERE created_at < NOW() - INTERVAL ' . SHEET_LOG_RETENTION_DAYS . ' DAY LIMIT 5000');
}

// ---------------------------------------------------------------------
// 2. Rate limit, per key (i.e. per store).
// ---------------------------------------------------------------------
$stmt = $pdo->prepare('SELECT COUNT(*) FROM sheet_import_log WHERE store_id = ? AND created_at > NOW() - INTERVAL 60 SECOND');
$stmt->execute([$storeRowId]);
if ((int) $stmt->fetchColumn() >= SHEET_RATE_LIMIT_PER_MINUTE) {
    sheet_fail(429, 'Too many requests — more than ' . SHEET_RATE_LIMIT_PER_MINUTE . ' in the last minute. Wait a minute, then edit the row again to retry.', 'rate_limited');
}

// ---------------------------------------------------------------------
// 3. Request-shape checks specific to the Sheet.
// ---------------------------------------------------------------------
$customer = sheet_str($body, 'customer');
$phone = sheet_str($body, 'phone');
$altPhone = sheet_str($body, 'alt_phone');
$productName = sheet_str($body, 'product');
$address = sheet_str($body, 'address');
$zone = sheet_str($body, 'zone');
$notes = sheet_str($body, 'notes');
$qty = $body['qty'] ?? null;
$amount = $body['amount'] ?? null;

$missing = [];
foreach (['Customer name' => $customer, 'Phone number' => $phone, 'Product' => $productName, 'Delivery address' => $address] as $label => $value) {
    if ($value === '') {
        $missing[] = $label;
    }
}
if ($missing) {
    sheet_fail(422, 'Missing: ' . implode(', ', $missing), 'validation_error');
}
// Amount is optional in the in-app form but required on a Sheet row. A
// non-numeric cell (e.g. "₦33,000" typed as text) arrives as null here.
if ($amount === null || $amount === '') {
    sheet_fail(422, 'Amount is missing or not a number — type digits only, e.g. 33000.', 'validation_error');
}

$productId = find_store_product_by_name($pdo, $storeRowId, $productName);
if ($productId === null) {
    sheet_fail(422, "Product '" . mb_substr($productName, 0, 100) . "' not found in your inventory", 'validation_error');
}

// ---------------------------------------------------------------------
// 4. Create the order (or return the one already created for this
// exact row). A per-store named lock serialises the duplicate check and
// the insert, so two copies of the same row arriving at once can't both
// slip past the check.
// ---------------------------------------------------------------------
$sheetCtx['hash'] = hash('sha256', json_encode([
    $storeRowId, mb_strtolower($customer), $phone, $altPhone, $productId, (string) $qty,
    mb_strtolower($address), mb_strtolower($zone), (string) $amount, $notes,
]));

$lockName = 'mf_sheet_import_' . $storeRowId;
$stmt = $pdo->prepare('SELECT GET_LOCK(?, 15)');
$stmt->execute([$lockName]);
if ((int) $stmt->fetchColumn() !== 1) {
    sheet_fail(503, 'The CRM is busy — edit the row again in a moment to retry.', 'server_error');
}

$response = null;
$validationError = '';
try {
    $stmt = $pdo->prepare('SELECT l.order_code, o.is_backorder FROM sheet_import_log l
        JOIN orders o ON o.order_code = l.order_code AND o.deleted = 0
        WHERE l.store_id = ? AND l.payload_hash = ? AND l.outcome IN ("success", "duplicate")
          AND l.created_at > NOW() - INTERVAL ' . SHEET_DUPLICATE_WINDOW_SECONDS . ' SECOND
        ORDER BY l.id DESC LIMIT 1');
    $stmt->execute([$storeRowId, $sheetCtx['hash']]);
    $existing = $stmt->fetch();
    if ($existing) {
        sheet_log('duplicate', 200, 'Identical row already imported — returned the existing order', $existing['order_code']);
        $response = ['success' => true, 'order_id' => $existing['order_code'], 'backorder' => (bool) $existing['is_backorder'], 'duplicate' => true];
    } else {
        try {
            $result = create_order($pdo, $storeRowId, $storeRowId, $store['store_name'] . ' (Google Sheet)', [
                'product_id' => $productId,
                'customer' => $customer,
                'phone' => $phone,
                'alt_phone' => $altPhone,
                'address' => $address,
                'zone' => $zone,
                'notes' => $notes,
                'amount' => $amount,
                'qty' => $qty,
            ]);
            sheet_log('success', 200, null, $result['order_code']);
            $response = ['success' => true, 'order_id' => $result['order_code'], 'backorder' => $result['is_backorder']];
        } catch (OrderValidationException $e) {
            $validationError = $e->getMessage();
        }
    }
} finally {
    $pdo->prepare('SELECT RELEASE_LOCK(?)')->execute([$lockName]);
}

if ($response === null) {
    sheet_fail(422, $validationError, 'validation_error');
}
json_response($response, 200);
