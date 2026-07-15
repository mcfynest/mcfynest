<?php
declare(strict_types=1);

define('MANIFEST_ENTRY', true);

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';

// Load config (db.php only requires it lazily inside db(), so pull the
// constants in early here too for FORCE_SECURE_COOKIES / APP_SECRET).
$configPath = __DIR__ . '/../config/config.php';
if (file_exists($configPath)) {
    require_once $configPath;
}

$isHttps = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
    || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
$useSecureCookies = (defined('FORCE_SECURE_COOKIES') && FORCE_SECURE_COOKIES) || $isHttps;

session_name('manifest_sess');
session_set_cookie_params([
    'lifetime' => 60 * 60 * 24 * 30,
    'path' => '/',
    'domain' => '',
    'secure' => $useSecureCookies,
    'httponly' => true,
    'samesite' => 'Lax',
]);
session_start();

require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/csrf.php';

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

// Convert PHP errors/exceptions into a JSON response instead of leaking
// HTML error pages (which would break the frontend's fetch().json()).
set_exception_handler(function (Throwable $e): void {
    error_log('[manifest] ' . $e->getMessage());
    json_error('Something went wrong on our end. Please try again.', 500);
});
set_error_handler(function (int $severity, string $message, string $file, int $line): bool {
    if (!(error_reporting() & $severity)) {
        return false;
    }
    throw new ErrorException($message, 0, $severity, $file, $line);
});

$method = $_SERVER['REQUEST_METHOD'];
if (in_array($method, ['POST', 'PATCH', 'PUT', 'DELETE'], true)) {
    if (!csrf_verify()) {
        json_error('Session expired — please refresh the page and try again.', 419);
    }
}
