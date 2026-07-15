<?php
declare(strict_types=1);

if (!defined('MANIFEST_ENTRY')) {
    http_response_code(403);
    exit('Forbidden');
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }

    $configPath = __DIR__ . '/../config/config.php';
    if (!file_exists($configPath)) {
        http_response_code(500);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'Server is not configured yet. Copy config/config.sample.php to config/config.php and fill in your database details.']);
        exit;
    }
    require_once $configPath;

    $dsn = 'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4';
    try {
        $pdo = new PDO($dsn, DB_USER, DB_PASS, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
    } catch (PDOException $e) {
        http_response_code(500);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'Could not connect to the database. Check config/config.php.']);
        exit;
    }

    return $pdo;
}
