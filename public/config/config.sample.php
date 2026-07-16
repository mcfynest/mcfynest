<?php
/**
 * Copy this file to config.php (same folder) and fill in your real
 * cPanel MySQL database details. config.php is git-ignored and blocked
 * from web access by the .htaccess in this folder — never commit real
 * credentials.
 */

if (!defined('MANIFEST_ENTRY')) {
    http_response_code(403);
    exit('Forbidden');
}

// --- Database ---------------------------------------------------------
// cPanel MySQL usernames/databases are usually prefixed with your
// cPanel account name, e.g. "myuser_manifest". Host is almost always
// "localhost" on shared hosting.
define('DB_HOST', 'localhost');
define('DB_NAME', 'cpaneluser_manifest');
define('DB_USER', 'cpaneluser_manifest');
define('DB_PASS', 'change-this-password');

// --- Security -----------------------------------------------------------
// Random long string used to sign/verify CSRF tokens. Generate one with:
//   php -r "echo bin2hex(random_bytes(32));"
define('APP_SECRET', 'change-this-to-a-random-64-char-string');

// One-time setup key required to run setup.php and create the first
// admin account. Set it here, run setup.php once, then delete setup.php
// (or blank this out) — see docs/DEPLOY.md.
define('SETUP_KEY', 'change-this-before-first-deploy');

// --- App ---------------------------------------------------------------
define('APP_NAME', 'McFynest Logistics');
define('APP_CURRENCY_SYMBOL', '₦');
define('LOW_STOCK_THRESHOLD', 1);

// Set to true only once you've confirmed the site is served over HTTPS —
// this makes session cookies HTTPS-only.
define('FORCE_SECURE_COOKIES', false);
