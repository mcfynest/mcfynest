<?php
declare(strict_types=1);
// Static shell only — all data loads via /api/*.php from app.js.
// PHP is used here just so this file lives naturally alongside the API
// on the same PHP-hosting stack (no separate static-file server needed).
?><!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>McFynest Logistics — Dispatch &amp; Order Management</title>
<meta name="theme-color" content="#1B2430">
<meta name="description" content="Keeping every delivery on track, together.">
<link rel="manifest" href="manifest.json">
<link rel="icon" href="assets/icons/icon-192.png">
<link rel="apple-touch-icon" href="assets/icons/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="McFynest">
<link rel="stylesheet" href="assets/css/app.css">
</head>
<body>
<div id="root" class="app"></div>
<div id="toast" class="toast"></div>
<div id="print-area" class="print-only"></div>
<script src="assets/js/app.js"></script>
</body>
</html>
