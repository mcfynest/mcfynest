<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/bootstrap_api.php';

$pdo = db();
$actor = require_actor();
$method = $_SERVER['REQUEST_METHOD'];

function withdrawal_row_for_client(array $w): array
{
    return [
        'id' => (int) $w['id'],
        'store' => $w['store_name'] ?? null,
        'amount' => (float) $w['amount'],
        'status' => $w['status'],
        'requestedAt' => strtotime($w['requested_at']) * 1000,
        'bankName' => $w['bank_name'] ?? null,
        'accountNumber' => $w['bank_account_number'] ?? null,
        'accountName' => $w['bank_account_name'] ?? null,
    ];
}

if ($method === 'GET') {
    if ($actor['type'] === 'admin') {
        require_admin_permission($pdo, $actor, 'withdrawals');

        $pending = $pdo->query("SELECT w.*, s.store_name, s.bank_name, s.bank_account_number, s.bank_account_name
            FROM withdrawals w JOIN stores s ON s.id = w.store_id
            WHERE w.status = 'pending' ORDER BY w.requested_at ASC")->fetchAll();

        $resolved = $pdo->query("SELECT w.*, s.store_name, s.bank_name, s.bank_account_number, s.bank_account_name
            FROM withdrawals w JOIN stores s ON s.id = w.store_id
            WHERE w.status != 'pending' ORDER BY w.requested_at DESC LIMIT 50")->fetchAll();

        json_response([
            'pending' => array_map('withdrawal_row_for_client', $pending),
            'resolved' => array_map('withdrawal_row_for_client', $resolved),
        ]);
    }

    // Store actor (owner or team member) — balance is visible to everyone
    // on the store's login, but only the owner can request/edit anything.
    if ($actor['type'] !== 'store') {
        json_error('Store access only.', 403);
    }
    $balance = store_available_balance($pdo, $actor['owner_row_id']);
    $stmt = $pdo->prepare('SELECT * FROM withdrawals WHERE store_id = ? ORDER BY requested_at DESC');
    $stmt->execute([$actor['owner_row_id']]);
    $history = array_map('withdrawal_row_for_client', $stmt->fetchAll());

    json_response([
        'balance' => $balance,
        'history' => $history,
        'requestedToday' => store_requested_withdrawal_today($pdo, $actor['owner_row_id']),
    ]);
}

if ($method === 'POST') {
    $actor = require_store_owner();
    $body = read_json_body();
    $amount = num_field($body, 'amount', 0);

    if ($amount <= 0) {
        json_error('Enter a valid amount.', 400);
    }

    $pdo->beginTransaction();
    try {
        // Lock this store's row as a mutex so two rapid requests can't
        // both pass the "already requested today" / balance checks.
        $stmt = $pdo->prepare('SELECT bank_name, bank_account_number, bank_account_name FROM stores WHERE id = ? FOR UPDATE');
        $stmt->execute([$actor['row_id']]);
        $bank = $stmt->fetch();

        if (!$bank || !$bank['bank_name'] || !$bank['bank_account_number'] || !$bank['bank_account_name']) {
            $pdo->rollBack();
            json_error('Add your bank account details before requesting a withdrawal.', 400);
        }
        if (store_requested_withdrawal_today($pdo, $actor['row_id'])) {
            $pdo->rollBack();
            json_error("You've already requested a withdrawal today — try again tomorrow.", 409);
        }
        $balance = store_available_balance($pdo, $actor['row_id']);
        if ($amount > $balance) {
            $pdo->rollBack();
            json_error('Enter a valid amount up to your available balance.', 400);
        }

        $pdo->prepare('INSERT INTO withdrawals (store_id, amount, status) VALUES (?, ?, "pending")')
            ->execute([$actor['row_id'], $amount]);

        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    json_response(['ok' => true], 201);
}

if ($method === 'PATCH') {
    require_admin();
    require_admin_permission($pdo, $actor, 'withdrawals');
    $body = read_json_body();
    $id = (int) ($body['id'] ?? 0);
    $status = str_field($body, 'status');

    if (!in_array($status, ['paid', 'declined'], true)) {
        json_error('Invalid status.', 400);
    }

    $stmt = $pdo->prepare("UPDATE withdrawals SET status = ?, resolved_at = NOW(), resolved_by_admin_id = ? WHERE id = ? AND status = 'pending'");
    $stmt->execute([$status, $actor['row_id'], $id]);

    if ($stmt->rowCount() === 0) {
        json_error('Withdrawal request not found or already resolved.', 404);
    }

    json_response(['ok' => true]);
}

json_error('Method not allowed.', 405);
