<?php
declare(strict_types=1);
define('MANIFEST_ENTRY', true);
require_once __DIR__ . '/includes/helpers.php';
require_once __DIR__ . '/includes/db.php';

$configPath = __DIR__ . '/config/config.php';
if (!file_exists($configPath)) {
    http_response_code(500);
    echo 'config/config.php is missing. Copy config/config.sample.php to config/config.php and fill it in first.';
    exit;
}
require_once $configPath;

$error = '';
$success = null;

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $key = $_POST['setup_key'] ?? '';
    $name = trim($_POST['name'] ?? '');
    $password = $_POST['password'] ?? '';
    $adminId = trim($_POST['admin_id'] ?? '');

    if (!defined('SETUP_KEY') || SETUP_KEY === '' || SETUP_KEY === 'change-this-before-first-deploy') {
        $error = 'Set a real SETUP_KEY in config/config.php first, then reload this page.';
    } elseif (!hash_equals(SETUP_KEY, $key)) {
        $error = 'Wrong setup key.';
    } elseif ($name === '' || strlen($password) < 6) {
        $error = 'Enter a name and a password of at least 6 characters.';
    } else {
        $pdo = db();
        if ($adminId === '') {
            $adminId = generate_unique_code($name, function ($code) use ($pdo) {
                $s = $pdo->prepare('SELECT 1 FROM admin_accounts WHERE admin_id = ?');
                $s->execute([$code]);
                return (bool) $s->fetchColumn();
            });
        } else {
            $adminId = strtoupper($adminId);
            $s = $pdo->prepare('SELECT 1 FROM admin_accounts WHERE admin_id = ?');
            $s->execute([$adminId]);
            if ($s->fetchColumn()) {
                $error = 'That admin ID is already taken.';
            }
        }

        if ($error === '') {
            $stmt = $pdo->prepare('INSERT INTO admin_accounts (admin_id, name, password_hash) VALUES (?, ?, ?)');
            $stmt->execute([$adminId, $name, password_hash($password, PASSWORD_BCRYPT)]);
            $success = ['admin_id' => $adminId, 'password' => $password, 'name' => $name];
        }
    }
}
?><!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Manifest — Admin setup</title>
<link rel="stylesheet" href="assets/css/app.css">
</head>
<body>
<div class="app" style="max-width:480px;">
  <div class="role-screen" style="padding-top:40px;">
    <div class="display role-title" style="font-size:28px;">ADMIN SETUP</div>
    <div class="role-tag">Create a dispatch admin login. Requires the SETUP_KEY from config/config.php — keep this page private, and delete or rename setup.php once you're done setting up your admin logins.</div>

    <div class="panel" style="text-align:left;width:100%;">
      <?php if ($error): ?>
        <div class="alert-banner"><?= htmlspecialchars($error) ?></div>
      <?php endif; ?>

      <?php if ($success): ?>
        <div class="once-box">
          <div>Admin login created for <?= htmlspecialchars($success['name']) ?>:</div>
          <div class="cred">ID: <span class="mono"><?= htmlspecialchars($success['admin_id']) ?></span> &nbsp;·&nbsp; Password: <span class="mono"><?= htmlspecialchars($success['password']) ?></span></div>
          <div class="warn">Copy this now — it will not be shown again. Share it with the admin securely.</div>
        </div>
        <p class="hint">Need to create another admin login? Submit the form again below. When you're done, delete or rename this file on the server.</p>
      <?php endif; ?>

      <form method="post">
        <label>Setup key</label>
        <input type="password" name="setup_key" required />
        <label>Admin's name</label>
        <input type="text" name="name" placeholder="e.g. Dispatch Team" required />
        <label>Admin ID (optional — leave blank to auto-generate)</label>
        <input type="text" name="admin_id" placeholder="e.g. ADM-1001" />
        <label>Password (at least 6 characters)</label>
        <input type="password" name="password" required minlength="6" />
        <button class="btn" type="submit" style="width:100%;">Create admin login</button>
      </form>
    </div>
  </div>
</div>
</body>
</html>
