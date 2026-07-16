<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/bootstrap_api.php';

$pdo = db();
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'POST') {
    // Pre-login "forgot my ID/password" flow — intentionally no require_actor()
    // here. Still CSRF-checked like every other POST (bootstrap_api.php),
    // using the pre-auth token the frontend fetches from session.php.
    $body = read_json_body();
    $type = str_field($body, 'type') === 'admin' ? 'admin' : 'store';
    $label = str_field($body, 'label');
    $contact = str_field($body, 'contact');

    if ($label === '' || $contact === '') {
        json_error('Fill in both fields.', 400);
    }

    $stmt = $pdo->prepare('INSERT INTO reset_requests (type, label, contact) VALUES (?, ?, ?)');
    $stmt->execute([$type, substr($label, 0, 255), substr($contact, 0, 255)]);

    json_response(['ok' => true], 201);
}

// Everything past this point is admin-only.
$actor = require_admin();

if ($method === 'GET') {
    $type = str_field($_GET, 'type') === 'admin' ? 'admin' : 'store';
    require_admin_permission($pdo, $actor, $type === 'admin' ? 'team' : 'stores');

    $stmt = $pdo->prepare('SELECT id, label, contact, created_at FROM reset_requests WHERE type = ? AND resolved = 0 ORDER BY created_at ASC');
    $stmt->execute([$type]);
    json_response(['requests' => array_map(function ($r) {
        return [
            'id' => (int) $r['id'],
            'label' => $r['label'],
            'contact' => $r['contact'],
            'createdAt' => strtotime($r['created_at']) * 1000,
        ];
    }, $stmt->fetchAll())]);
}

if ($method === 'PATCH') {
    $body = read_json_body();
    $id = (int) ($body['id'] ?? 0);

    $stmt = $pdo->prepare('SELECT type FROM reset_requests WHERE id = ?');
    $stmt->execute([$id]);
    $type = $stmt->fetchColumn();
    if (!$type) {
        json_error('Request not found.', 404);
    }
    require_admin_permission($pdo, $actor, $type === 'admin' ? 'team' : 'stores');

    $pdo->prepare('UPDATE reset_requests SET resolved = 1, resolved_at = NOW() WHERE id = ?')->execute([$id]);
    json_response(['ok' => true]);
}

json_error('Method not allowed.', 405);
