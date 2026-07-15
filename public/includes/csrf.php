<?php
declare(strict_types=1);

if (!defined('MANIFEST_ENTRY')) {
    http_response_code(403);
    exit('Forbidden');
}

function csrf_token(): string
{
    if (empty($_SESSION['csrf'])) {
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
    }
    return $_SESSION['csrf'];
}

function csrf_verify(): bool
{
    $sent = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    $stored = $_SESSION['csrf'] ?? '';
    return $sent !== '' && $stored !== '' && hash_equals($stored, $sent);
}
