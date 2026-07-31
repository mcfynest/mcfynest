# Deploying McFynest Logistics to Namecheap cPanel shared hosting

This app is plain PHP + MySQL — no Node.js, no build step, no Composer
dependencies. It runs on standard shared hosting. These steps assume
Namecheap's cPanel, but apply to almost any cPanel host.

You'll need: your cPanel login, and a domain (or subdomain) already
pointed at that hosting account. Because every asset/API reference in
this app uses a relative path (`assets/...`, `api/...`, never a leading
`/`), it works the same whether it's uploaded to your domain's root
(`public_html/`) or a subfolder like `public_html/dispatch/` (i.e.
`thecubedmall.com/dispatch/`) — no code changes needed either way, just
upload to whichever folder you want it reachable from.

## Already have this live and just updating it?

If you deployed this app before and are picking up a later round of
changes, you don't need to repeat the whole walkthrough below — just:

1. **Import every migration you haven't run yet, in order** — in
   phpMyAdmin, select your existing database, go to **Import**, and run
   each of these in sequence (skip any you're sure already applied; each
   one is safe to re-run if you're not sure):
   - `sql/migration_002_v2_features.sql` — wallet/withdrawals, expenses,
     reports, admin permissions.
   - `sql/migration_003_v3_crm_revamp.sql` — 10 order statuses, Trash
     (soft-delete).
   - `sql/migration_004_v3_round2_fixes.sql` — single-level Undo,
     delivery zones, withdrawal-request tracking.
   - `sql/migration_005_v3_round3_fixes.sql` — the stock **reservation
     model** (physical stock is now only deducted once an order reaches
     Delivered, not the moment it's placed) and backorders. Read the
     comments at the top of this file before running it on a database
     with real orders in flight — it reconciles existing stock counts to
     match the new model.
   - `sql/migration_006_v3_round4_fixes.sql` — per-order status history,
     and ties a sent report to the exact order codes it covers.
   - `sql/migration_007_v3_round5_fixes.sql` — removes the unused
     "Shipped" status (any order sitting in it is moved to "Out for
     delivery" first, then the status list itself drops the value). This
     is the only new migration for round 5 — every other round 5 fix
     (the Orders pill bug, money-blanking in reports, product renaming,
     order detail editing, expense editing, the sent-reports sheet)
     reuses columns that already exist as of migration 006.
2. **Re-upload the changed files** from `public/` — safest is to
   re-upload the whole `public/` folder's contents again (File Manager
   → Extract a fresh zip over the old one, or FTP overwrite). Your own
   `config/config.php` won't be in this project's zip, so it's never
   overwritten — nothing to reconfigure.
3. If you'd previously deleted `setup.php` (as instructed below) and
   need to add another admin login, re-upload just that one file, visit
   it, create the login, then delete it again.

That's it — steps 1–9 below are for a first-time install.

## 1. Create the MySQL database

1. In cPanel, open **MySQL® Database Wizard**.
2. **Step 1 — Create a Database**: name it something like `manifest`
   (cPanel will prefix it automatically, e.g. `yourcpaneluser_manifest`).
   Click **Next Step**.
3. **Step 2 — Create a database user**: pick a username (e.g. `manifest`,
   becomes `yourcpaneluser_manifest`) and a strong password — click
   **Generate Password** and save it somewhere safe (a password manager,
   not a text file on your desktop).
4. **Step 3 — Add user to database**: check **ALL PRIVILEGES**, then
   **Next Step / Make Changes**.
5. Write down the three values you now have: the full database name, the
   full username, and the password. You'll need these in step 4.

## 2. Import the schema

1. In cPanel, open **phpMyAdmin**.
2. Select your new database in the left sidebar.
3. Click the **Import** tab.
4. Click **Choose File** and select `sql/schema.sql` from this project
   (on your own computer — you do not need to upload it to the server
   first, phpMyAdmin's import uploads it directly from your browser).
5. Click **Go**. You should see 5 tables created: `stores`,
   `admin_accounts`, `products`, `agent_products`, `orders`.
6. Repeat the same Import steps, in order, for each remaining file in
   `sql/`: `migration_002_v2_features.sql` through
   `migration_007_v3_round5_fixes.sql`. On a brand-new database most of
   these have little or nothing to do (no data yet to migrate) — they're
   still required, since each one also adds the columns/tables that
   round of features needs.

## 3. Upload the application files

Only the contents of this project's **`public/`** folder get uploaded —
that folder *is* your web root. `sql/` and `docs/` stay on your own
computer; the server never needs them.

1. In cPanel, open **File Manager**, and go to `public_html` (if this
   app should live at your domain's root, e.g. `https://yourdomain.com/`)
   or into a subfolder / addon domain's document root if you want it at
   a path like `https://yourdomain.com/dispatch/`.
2. Upload every file and folder **from inside `public/`** (not the
   `public` folder itself — its *contents*): `index.php`, `manifest.json`,
   `sw.js`, `setup.php`, `assets/`, `api/`, `config/`, `includes/`.
   - Easiest: zip the contents of `public/` on your computer, upload the
     zip via File Manager, then use File Manager's **Extract** — faster
     than uploading hundreds of small files over FTP.
   - Or use an FTP client (FileZilla, Cyberduck) with the FTP details
     from cPanel's **FTP Accounts** page.

## 4. Configure the app

1. In File Manager, go into the `config` folder.
2. Duplicate `config.sample.php` and rename the copy to `config.php`
   (same folder).
3. Edit `config.php` (File Manager has a built-in code editor — right
   click → Edit) and fill in:
   - `DB_HOST` → leave as `localhost`
   - `DB_NAME`, `DB_USER`, `DB_PASS` → the three values from step 1
   - `APP_SECRET` → any random 64-character string. If you have SSH
     access you can generate one with `php -r "echo bin2hex(random_bytes(32));"`;
     otherwise any long random string you type yourself is fine.
   - `SETUP_KEY` → a password only you know — you'll use it once, next.
4. Save the file.

`config.php` is already blocked from direct web access by the
`.htaccess` file sitting next to it — don't remove that `.htaccess`.

## 5. Check the PHP version

In cPanel, open **MultiPHP Manager**, find your domain, and make sure
it's set to **PHP 8.0 or newer** (8.1–8.3 all work fine). This app uses
no PHP extensions beyond what's enabled by default (`pdo_mysql`, `session`,
`json`), which every cPanel PHP version ships with.

## 6. Create your first dispatch admin login

1. Visit `https://yourdomain.com/setup.php` (or wherever you uploaded
   the app) in your browser.
2. Enter the `SETUP_KEY` you set in `config.php`, a name (e.g. "Dispatch
   Team"), and a password. Leave Admin ID blank to auto-generate one.
3. Submit — you'll see the generated Admin ID and password **once**.
   Copy both somewhere safe immediately; they cannot be shown again
   (the password is hashed in the database from that point on).
4. **Important — once you've created the admin logins you need, delete
   or rename `setup.php` on the server** (File Manager → right-click →
   Delete, or rename it to something private). Leaving it live means
   anyone who guesses your setup key could create an admin login.

## 7. Enable HTTPS

Most Namecheap cPanel plans include free **AutoSSL**. In cPanel, open
**SSL/TLS Status**, select your domain, and run AutoSSL if it hasn't
already issued a certificate (this can take a few minutes to a few
hours the first time). The app's `.htaccess` redirects HTTP → HTTPS
automatically — if your domain doesn't have a certificate yet, open
`public/.htaccess` and comment out the `RewriteCond`/`RewriteRule` HTTPS
redirect block until it does, or visitors will hit a certificate error.

## 8. Test it

1. Visit your domain. You should see the **MCFYNEST LOGISTICS** login
   screen — a single Login ID field takes either a Store ID or an Admin ID.
2. Log in with the admin ID/password from step 6.
3. Use **Stores → Create a store** to make your first store login, copy
   its generated Store ID + password.
4. Log out, log back in with that Store ID/password, log a stock
   drop-off under **Inventory**, then place a test order under **Orders**.
5. Log back in as admin — you should see the "New orders waiting"
   popup with that test order in it.

## 9. Install it as an app (PWA)

- **Android (Chrome)**: visit the site, tap the **⋮** menu → **Add to
  Home screen** / **Install app**.
- **iPhone/iPad (Safari)**: visit the site, tap the **Share** icon →
  **Add to Home Screen**.
- **Desktop (Chrome/Edge)**: an install icon appears in the address bar.

Once installed it opens full-screen with no browser address bar, using
the app icon generated in `assets/icons/`.

## Troubleshooting

- **Blank white page**: check cPanel's **Errors** log (or
  `public_html/error_log`) for the PHP error. Almost always a missing
  `config.php` or wrong DB credentials.
- **"Could not connect to the database"**: double-check `DB_HOST` is
  `localhost` and the DB name/user/password in `config.php` exactly
  match what cPanel shows under MySQL® Databases (including the
  account-name prefix).
- **Login always says wrong ID/password**: confirm `sql/schema.sql` was
  imported into the *same* database `config.php` points at.
- **CSS/JS not loading / page looks unstyled**: confirm you uploaded the
  *contents* of `public/`, not the `public` folder itself (so `index.php`
  sits directly in `public_html`, not `public_html/public/index.php`).
- **Redirect loop / "too many redirects"**: your domain doesn't have SSL
  yet but `.htaccess` is forcing HTTPS — see step 7.

## Updating the app later

To ship a change: edit the files under `public/`, then re-upload just
the changed files via File Manager or FTP. There's no build step and no
server restart needed — PHP picks up changes on the next page load.
