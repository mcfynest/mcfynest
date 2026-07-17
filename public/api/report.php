<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/bootstrap_api.php';

$pdo = db();
$actor = require_actor();
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    if ($actor['type'] === 'admin') {
        // Report access is always included for every admin login and can't
        // be gated behind the "Stores" checklist item — so this list of
        // store options doesn't depend on the "stores" permission, just on
        // being logged in as an admin at all.
        $storeOptions = $pdo->query('SELECT store_id, store_name FROM stores WHERE role = "owner" AND is_active = 1 ORDER BY store_name')->fetchAll();

        $storeLoginId = str_field($_GET, 'store_id');
        if ($storeLoginId === '') {
            json_response(['store' => null, 'storeId' => null, 'rows' => [], 'totals' => ['amount' => 0, 'charge' => 0, 'balance' => 0], 'storeOptions' => $storeOptions]);
        }
        $stmt = $pdo->prepare('SELECT id, store_name FROM stores WHERE store_id = ? AND role = "owner"');
        $stmt->execute([$storeLoginId]);
        $store = $stmt->fetch();
        if (!$store) {
            json_error('Store not found.', 404);
        }
        $ownerRowId = (int) $store['id'];
        $storeName = $store['store_name'];
    } else {
        $ownerRowId = $actor['owner_row_id'];
        $stmt = $pdo->prepare('SELECT store_name, store_id FROM stores WHERE id = ?');
        $stmt->execute([$ownerRowId]);
        $storeRow = $stmt->fetch();
        $storeName = $storeRow['store_name'];
        $storeLoginId = $storeRow['store_id'];
    }

    $q = str_field($_GET, 'q');
    $sql = 'SELECT * FROM orders WHERE store_id = ? AND deleted = 0';
    $params = [$ownerRowId];
    apply_date_range($sql, $params, 'updated_at');
    if ($q !== '') {
        $sql .= ' AND (customer_name LIKE ? OR phone LIKE ? OR alt_phone LIKE ?)';
        $like = '%' . $q . '%';
        $params[] = $like;
        $params[] = $like;
        $params[] = $like;
    }
    $sql .= ' ORDER BY updated_at ASC';

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $orders = $stmt->fetchAll();

    $totalAmount = 0.0;
    $totalCharge = 0.0;
    $totalBalance = 0.0;
    $rows = array_map(function ($o) use (&$totalAmount, &$totalCharge, &$totalBalance) {
        $charge = (float) $o['delivery_fee'] + (float) $o['other_charges'];
        $amount = (float) $o['amount'];
        $balance = $amount - $charge;
        $totalAmount += $amount;
        $totalCharge += $charge;
        $totalBalance += $balance;
        return [
            'id' => $o['order_code'],
            'customer' => $o['customer_name'],
            'phone' => $o['phone'],
            'item' => $o['product_name'],
            'qty' => (int) $o['qty'],
            'dropoff' => $o['delivery_address'],
            'status' => $o['status'],
            'amount' => $amount,
            'charge' => $charge,
            'balance' => $balance,
            // Day the order was last resolved (updated) — this is what the
            // report groups by, not the day it was placed.
            'date' => date('Y-m-d', strtotime($o['updated_at'])),
        ];
    }, $orders);

    json_response([
        'store' => $storeName,
        'storeId' => $storeLoginId,
        'rows' => $rows,
        'totals' => ['amount' => $totalAmount, 'charge' => $totalCharge, 'balance' => $totalBalance],
        'storeOptions' => $storeOptions ?? null,
    ]);
}

if ($method === 'POST') {
    $actor = require_admin();
    $body = read_json_body();
    $storeLoginId = str_field($body, 'store_id');
    $rangeLabel = str_field($body, 'range_label') ?: 'All time';
    $dateFrom = str_field($body, 'date_from');
    $dateTo = str_field($body, 'date_to');

    $stmt = $pdo->prepare('SELECT id FROM stores WHERE store_id = ? AND role = "owner"');
    $stmt->execute([$storeLoginId]);
    $ownerRowId = $stmt->fetchColumn();
    if (!$ownerRowId) {
        json_error('Store not found.', 404);
    }

    $validFrom = preg_match('/^\d{4}-\d{2}-\d{2}$/', $dateFrom) ? $dateFrom : null;
    $validTo = preg_match('/^\d{4}-\d{2}-\d{2}$/', $dateTo) ? $dateTo : null;

    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare('INSERT INTO sent_reports (store_id, range_label, date_from, date_to, sent_by_admin_id) VALUES (?, ?, ?, ?, ?)');
        $stmt->execute([$ownerRowId, $rangeLabel, $validFrom, $validTo, $actor['row_id']]);

        // Mark every "Delivered" order in this filtered range as "Remitted"
        // — meaning it's now been reported/reconciled, distinct from actual
        // bank payment (handled separately by Withdrawals). This prevents
        // the same delivered orders from being reported as outstanding
        // again in a future report. Wallet balance keeps counting Remitted
        // the same as Delivered (see store_delivered_total()).
        $updateSql = "UPDATE orders SET status = 'remitted', updated_at = CURRENT_TIMESTAMP WHERE store_id = ? AND status = 'delivered' AND deleted = 0";
        $updateParams = [$ownerRowId];
        if ($validFrom !== null) {
            $updateSql .= ' AND updated_at >= ?';
            $updateParams[] = $validFrom . ' 00:00:00';
        }
        if ($validTo !== null) {
            $updateSql .= ' AND updated_at <= ?';
            $updateParams[] = $validTo . ' 23:59:59';
        }
        $pdo->prepare($updateSql)->execute($updateParams);

        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    json_response(['ok' => true], 201);
}

json_error('Method not allowed.', 405);
