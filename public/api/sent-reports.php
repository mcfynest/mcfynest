<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/bootstrap_api.php';

$pdo = db();
$actor = require_store();
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $stmt = $pdo->prepare('SELECT id, range_label, date_from, date_to, sent_at FROM sent_reports WHERE store_id = ? AND acknowledged = 0 ORDER BY sent_at DESC');
    $stmt->execute([$actor['owner_row_id']]);
    $rows = $stmt->fetchAll();
    json_response(['pending' => array_map(function ($r) {
        return [
            'id' => (int) $r['id'],
            'rangeLabel' => $r['range_label'],
            'dateFrom' => $r['date_from'],
            'dateTo' => $r['date_to'],
            'sentAt' => strtotime($r['sent_at']) * 1000,
        ];
    }, $rows)]);
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
