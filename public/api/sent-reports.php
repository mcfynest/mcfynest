<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/bootstrap_api.php';

$pdo = db();
$actor = require_store();
$method = $_SERVER['REQUEST_METHOD'];

/** Builds one full formatted sheet row from an order, blanking Amount for
 * Failed delivery/Cancelled/Returned orders the same way report.php does —
 * a sent report is a frozen snapshot, but the money rule is the same rule
 * everywhere it's shown. Accumulates into the totals passed by reference. */
function sheet_row_for_order(array $o, float &$totalAmount, float &$totalCharge, float &$totalBalance): array
{
    $charge = (float) $o['delivery_fee'] + (float) $o['other_charges'];
    $amount = in_array($o['status'], FAILED_STATUSES, true) ? 0.0 : (float) $o['amount'];
    $balance = $amount - $charge;
    $totalAmount += $amount;
    $totalCharge += $charge;
    $totalBalance += $balance;
    return [
        'id' => $o['order_code'],
        'customer' => $o['customer_name'],
        'item' => $o['product_name'],
        'qty' => (int) $o['qty'],
        'dropoff' => $o['delivery_address'],
        'status' => $o['status'],
        'amount' => $amount,
        'charge' => $charge,
        'balance' => $balance,
    ];
}

if ($method === 'GET') {
    $sheetId = (int) ($_GET['id'] ?? 0);

    if ($sheetId > 0) {
        // A single sent report's full formatted sheet — only the store it
        // was sent to can view it. order_ids (added in migration 006) is
        // the authoritative record of exactly which orders were included;
        // date_from/date_to/range_label are kept only as the descriptive
        // label for the view the admin was looking at when they sent it.
        $stmt = $pdo->prepare('SELECT sr.id, sr.range_label, sr.date_from, sr.date_to, sr.sent_at, sr.order_ids, s.store_name
            FROM sent_reports sr JOIN stores s ON s.id = sr.store_id
            WHERE sr.id = ? AND sr.store_id = ?');
        $stmt->execute([$sheetId, $actor['owner_row_id']]);
        $report = $stmt->fetch();
        if (!$report) {
            json_error('Report not found.', 404);
        }

        $orderIds = $report['order_ids'] ? json_decode((string) $report['order_ids'], true) : [];
        $orderIds = is_array($orderIds) ? $orderIds : [];

        $totalAmount = 0.0;
        $totalCharge = 0.0;
        $totalBalance = 0.0;
        $rows = [];
        if ($orderIds) {
            $placeholders = implode(',', array_fill(0, count($orderIds), '?'));
            $stmt = $pdo->prepare("SELECT * FROM orders WHERE order_code IN ($placeholders) ORDER BY updated_at ASC");
            $stmt->execute($orderIds);
            foreach ($stmt->fetchAll() as $o) {
                $rows[] = sheet_row_for_order($o, $totalAmount, $totalCharge, $totalBalance);
            }
        }

        json_response([
            'id' => (int) $report['id'],
            'store' => $report['store_name'],
            'rangeLabel' => $report['range_label'],
            'dateFrom' => $report['date_from'],
            'dateTo' => $report['date_to'],
            'sentAt' => strtotime($report['sent_at']) * 1000,
            'rows' => $rows,
            'totals' => ['amount' => $totalAmount, 'charge' => $totalCharge, 'balance' => $totalBalance],
        ]);
    }

    $stmt = $pdo->prepare('SELECT id, range_label, date_from, date_to, sent_at FROM sent_reports WHERE store_id = ? AND acknowledged = 0 ORDER BY sent_at DESC');
    $stmt->execute([$actor['owner_row_id']]);
    $pendingRows = $stmt->fetchAll();

    // Full browsable history, newest-first — every report ever sent to
    // this store, not just the unacknowledged ones the login popup cares
    // about. orderCount is derived from order_ids since that's the
    // authoritative list of what was actually included.
    $stmt = $pdo->prepare('SELECT id, range_label, date_from, date_to, sent_at, acknowledged, order_ids FROM sent_reports WHERE store_id = ? ORDER BY sent_at DESC LIMIT 200');
    $stmt->execute([$actor['owner_row_id']]);
    $historyRows = $stmt->fetchAll();

    json_response([
        'pending' => array_map(function ($r) {
            return [
                'id' => (int) $r['id'],
                'rangeLabel' => $r['range_label'],
                'dateFrom' => $r['date_from'],
                'dateTo' => $r['date_to'],
                'sentAt' => strtotime($r['sent_at']) * 1000,
            ];
        }, $pendingRows),
        'history' => array_map(function ($r) {
            $ids = $r['order_ids'] ? json_decode((string) $r['order_ids'], true) : [];
            return [
                'id' => (int) $r['id'],
                'rangeLabel' => $r['range_label'],
                'dateFrom' => $r['date_from'],
                'dateTo' => $r['date_to'],
                'sentAt' => strtotime($r['sent_at']) * 1000,
                'acknowledged' => (bool) $r['acknowledged'],
                'orderCount' => is_array($ids) ? count($ids) : 0,
            ];
        }, $historyRows),
    ]);
}

if ($method === 'POST') {
    $body = read_json_body();
    if (($body['action'] ?? '') !== 'ack') {
        json_error('Unknown action.', 400);
    }
    $pdo->prepare('UPDATE sent_reports SET acknowledged = 1, acknowledged_at = NOW() WHERE store_id = ? AND acknowledged = 0')
        ->execute([$actor['owner_row_id']]);
    json_response(['ok' => true]);
}

json_error('Method not allowed.', 405);
