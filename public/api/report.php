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
        // Failed delivery/Cancelled/Returned orders never actually
        // collected money from the customer — Amount shows blank for
        // these, but the delivery charge still counts against the
        // balance (a failed-delivery attempt fee is real cost either way).
        $amount = in_array($o['status'], FAILED_STATUSES, true) ? 0.0 : (float) $o['amount'];
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
    $orderIds = array_values(array_filter(array_map('strval', $body['order_ids'] ?? [])));

    if (!$orderIds) {
        json_error('No orders specified to send.', 400);
    }

    $stmt = $pdo->prepare('SELECT id, store_name FROM stores WHERE store_id = ? AND role = "owner"');
    $stmt->execute([$storeLoginId]);
    $store = $stmt->fetch();
    if (!$store) {
        json_error('Store not found.', 404);
    }
    $ownerRowId = (int) $store['id'];

    $validFrom = preg_match('/^\d{4}-\d{2}-\d{2}$/', $dateFrom) ? $dateFrom : null;
    $validTo = preg_match('/^\d{4}-\d{2}-\d{2}$/', $dateTo) ? $dateTo : null;

    $stmt = $pdo->prepare('SELECT name FROM admin_accounts WHERE id = ?');
    $stmt->execute([$actor['row_id']]);
    $adminName = (string) $stmt->fetchColumn();

    $pdo->beginTransaction();
    try {
        // This is the money-affecting step, so nothing here is trusted from
        // the client beyond which order codes were checked in the preview:
        // re-select and re-validate every one of them against the current
        // database state — must belong to this exact store, must not be
        // deleted, and must still be Delivered right now (an order could
        // have moved on since the preview was opened a moment ago). Only
        // orders that pass all three get marked Remitted; anything else is
        // silently excluded and reflected in the response counts, same
        // "skip rather than fail the batch" principle as bulk_status.
        $placeholders = implode(',', array_fill(0, count($orderIds), '?'));
        $stmt = $pdo->prepare("SELECT id, order_code, status_history FROM orders
            WHERE order_code IN ($placeholders) AND store_id = ? AND deleted = 0 AND status = 'delivered' FOR UPDATE");
        $stmt->execute(array_merge($orderIds, [$ownerRowId]));
        $eligible = $stmt->fetchAll();

        if (!$eligible) {
            $pdo->rollBack();
            json_error('None of the selected orders are still eligible to send (they may have changed status already). Refresh and try again.', 409);
        }

        $eligibleCodes = array_column($eligible, 'order_code');
        $upd = $pdo->prepare("UPDATE orders SET status = 'remitted', prev_status = 'delivered', last_updated_by_name = ?, seen_by_admin = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
        foreach ($eligible as $row) {
            $upd->execute([$adminName, $row['id']]);
            append_status_history($pdo, (int) $row['id'], $row['status_history'], 'remitted', $adminName);
        }

        $stmt = $pdo->prepare('INSERT INTO sent_reports (store_id, range_label, date_from, date_to, sent_by_admin_id, order_ids) VALUES (?, ?, ?, ?, ?, ?)');
        $stmt->execute([$ownerRowId, $rangeLabel, $validFrom, $validTo, $actor['row_id'], json_encode($eligibleCodes)]);

        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    json_response([
        'ok' => true,
        'sentCount' => count($eligibleCodes),
        'skippedCount' => count($orderIds) - count($eligibleCodes),
        'orderIds' => $eligibleCodes,
    ], 201);
}

json_error('Method not allowed.', 405);
