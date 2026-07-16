<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/bootstrap_api.php';

$pdo = db();
$actor = require_store_owner();
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $stmt = $pdo->prepare('SELECT bank_name, bank_account_number, bank_account_name FROM stores WHERE id = ?');
    $stmt->execute([$actor['row_id']]);
    $row = $stmt->fetch();
    json_response([
        'bankName' => $row['bank_name'] ?? null,
        'accountNumber' => $row['bank_account_number'] ?? null,
        'accountName' => $row['bank_account_name'] ?? null,
    ]);
}

if ($method === 'POST' || $method === 'PATCH') {
    $body = read_json_body();
    $bankName = str_field($body, 'bankName');
    $accountNumber = str_field($body, 'accountNumber');
    $accountName = str_field($body, 'accountName');

    if ($bankName === '' || $accountNumber === '' || $accountName === '') {
        json_error('Fill in all bank details.', 400);
    }

    $pdo->prepare('UPDATE stores SET bank_name = ?, bank_account_number = ?, bank_account_name = ? WHERE id = ?')
        ->execute([$bankName, $accountNumber, $accountName, $actor['row_id']]);

    json_response(['ok' => true]);
}

json_error('Method not allowed.', 405);
