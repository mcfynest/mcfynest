<?php
declare(strict_types=1);
require_once __DIR__ . '/../includes/bootstrap_api.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Method not allowed.', 405);
}

logout_actor();
session_start();
json_response(['csrf_token' => csrf_token(), 'actor' => null]);
