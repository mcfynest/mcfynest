<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/bootstrap_api.php';
require_once __DIR__ . '/../includes/orders_lib.php';

// The only place a store's Sheet API key (stores.sheet_api_key) is ever
// returned — every other stores/session/login response leaves it out,
// same care as password hashes.
//
// GET                                  store owner: view their own key (view-only)
// POST {action:'reveal', id}           admin: show a store's key
// POST {action:'regenerate', id}       admin: replace it; the old key stops working at once
//
// A key is generated the first time it's viewed/revealed.

header('Cache-Control: no-store');

$pdo = db();
$actor = require_actor();
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    // Team-member logins can't see it — regenerating is admin-only and
    // the key is effectively the store's order-creation credential.
    $actor = require_store_owner();
    $key = ensure_sheet_api_key($pdo, $actor['row_id']);
    if ($key === null) {
        json_error('Store not found.', 404);
    }
    json_response(['sheet_api_key' => $key]);
}

if ($method === 'POST') {
    require_admin();
    require_admin_permission($pdo, $actor, 'stores');

    $body = read_json_body();
    $action = str_field($body, 'action');
    $rowId = (int) ($body['id'] ?? 0);

    if ($action === 'reveal') {
        $key = ensure_sheet_api_key($pdo, $rowId);
    } elseif ($action === 'regenerate') {
        $key = regenerate_sheet_api_key($pdo, $rowId);
    } else {
        json_error('Unknown action.', 400);
    }
    if ($key === null) {
        json_error('Store not found (Sheet API keys belong to the main store login, not team members).', 404);
    }
    json_response(['id' => $rowId, 'sheet_api_key' => $key]);
}

json_error('Method not allowed.', 405);
