<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/bootstrap_api.php';

// This whole endpoint must stay admin-only, gated on the "expenses"
// permission — rider pay and the admin's margin must never be visible
// to a store, per the business model (McFynest negotiates rider rates,
// adds a margin, and only the marked-up delivery fee is ever shown to
// stores via orders.php).
$pdo = db();
$actor = require_admin();
require_admin_permission($pdo, $actor, 'expenses');
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $feesSql = "SELECT COALESCE(SUM(delivery_fee + other_charges), 0) FROM orders WHERE 1=1";
    $feesParams = [];
    apply_date_range($feesSql, $feesParams, 'updated_at');
    $stmt = $pdo->prepare($feesSql);
    $stmt->execute($feesParams);
    $feesEarned = (float) $stmt->fetchColumn();

    $expSql = "SELECT * FROM expenses WHERE 1=1";
    $expParams = [];
    apply_date_range($expSql, $expParams, 'expense_date', true);
    $expSql .= ' ORDER BY created_at DESC';
    $stmt = $pdo->prepare($expSql);
    $stmt->execute($expParams);
    $expenseRows = $stmt->fetchAll();

    $totalExpenses = array_sum(array_map(fn($e) => (float) $e['amount'], $expenseRows));

    json_response([
        'feesEarned' => $feesEarned,
        'totalExpenses' => $totalExpenses,
        'netProfit' => $feesEarned - $totalExpenses,
        'expenses' => array_map(function ($e) {
            return [
                'id' => (int) $e['id'],
                'type' => $e['type'],
                'desc' => $e['description'],
                'amount' => (float) $e['amount'],
                'orderRef' => $e['order_ref'],
                'date' => $e['expense_date'],
                'note' => $e['note'],
                'createdAt' => strtotime($e['created_at']) * 1000,
            ];
        }, $expenseRows),
    ]);
}

if ($method === 'POST') {
    $body = read_json_body();
    $type = str_field($body, 'type') === 'rider' ? 'rider' : 'other';
    $desc = str_field($body, 'desc');
    $amount = num_field($body, 'amount', 0);
    $orderRef = str_field($body, 'orderRef');
    $date = str_field($body, 'date');
    $note = str_field($body, 'note');

    if ($desc === '' || $amount <= 0) {
        json_error('Enter a description and a valid amount.', 400);
    }
    if ($date === '' || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
        $date = date('Y-m-d');
    }

    $stmt = $pdo->prepare('INSERT INTO expenses (type, description, amount, order_ref, expense_date, note, created_by_admin_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    $stmt->execute([$type, $desc, $amount, $orderRef ?: null, $date, $note ?: null, $actor['row_id']]);

    json_response(['id' => (int) $pdo->lastInsertId()], 201);
}

if ($method === 'PATCH') {
    $body = read_json_body();
    $id = (int) ($body['id'] ?? 0);
    $type = str_field($body, 'type') === 'rider' ? 'rider' : 'other';
    $desc = str_field($body, 'desc');
    $amount = num_field($body, 'amount', 0);
    $orderRef = str_field($body, 'orderRef');
    $date = str_field($body, 'date');
    $note = str_field($body, 'note');

    if ($id <= 0 || $desc === '' || $amount <= 0) {
        json_error('Enter a description and a valid amount.', 400);
    }
    if ($date === '' || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
        $date = date('Y-m-d');
    }

    // Checked with its own SELECT, not the UPDATE's affected-row count —
    // saving a no-op edit (nothing actually changed) would otherwise come
    // back as a false "not found" (see the same fix in products.php's
    // rename action for the full explanation).
    $stmt = $pdo->prepare('SELECT 1 FROM expenses WHERE id = ?');
    $stmt->execute([$id]);
    if (!$stmt->fetchColumn()) {
        json_error('Expense not found.', 404);
    }
    $pdo->prepare('UPDATE expenses SET type = ?, description = ?, amount = ?, order_ref = ?, expense_date = ?, note = ? WHERE id = ?')
        ->execute([$type, $desc, $amount, $orderRef ?: null, $date, $note ?: null, $id]);
    json_response(['ok' => true]);
}

if ($method === 'DELETE') {
    $body = read_json_body();
    $id = (int) ($body['id'] ?? 0);

    $stmt = $pdo->prepare('DELETE FROM expenses WHERE id = ?');
    $stmt->execute([$id]);
    if ($stmt->rowCount() === 0) {
        json_error('Expense not found.', 404);
    }
    json_response(['ok' => true]);
}

json_error('Method not allowed.', 405);
