- 👋 Hi, I’m @Oladapo
- 👀 I’m interested in Business Analysis, Product Analysis, Data Analysis
- 🌱 I’m currently learning Business Analysis
- 💞️ I’m looking to collaborate on Organizations Needing My Services
- 📫 How to reach me https://www.linkedin.com/in/oladapo-kolawole-75b063105/

<!---
mcfynest/mcfynest is a ✨ special ✨ repository because its `README.md` (this file) appears on your GitHub profile.
You can click the Preview link to take a look at your changes.
--->

---

## McFynest Logistics — Dispatch & Order Management

A production dispatch/order management app for a logistics company and
the stores it delivers for: stores log stock drop-offs, raise delivery
orders against that stock, a dispatch admin team tracks every order
through to delivery, and stores get a wallet that pays out automatically
as orders are delivered.

Plain PHP + MySQL (no Node.js, no build step) — built to run on standard
shared/cPanel hosting. Installable as a PWA on phones.

- **App code**: [`public/`](public/) — this folder's contents are what
  gets uploaded to your web host.
- **Database schema**: [`sql/schema.sql`](sql/schema.sql) (base) +
  [`sql/migration_002_v2_features.sql`](sql/migration_002_v2_features.sql)
  (additive — positions/permissions, wallet/withdrawals, expenses,
  reports, forgot-login requests).
- **Deployment walkthrough**: [`docs/DEPLOY.md`](docs/DEPLOY.md) —
  step-by-step Namecheap cPanel setup (MySQL database, file upload,
  config, first admin login, HTTPS, PWA install), including how to
  apply the migration to an already-live deployment.

### Roles
- **Store owner** — full access for their store: log stock drop-offs,
  raise orders, manage team logins and their permissions, bank
  details/withdrawals, reports.
- **Team member** — a login created by a store owner, with a position
  and a permissions checklist (New Order / Stock Drop-offs / Order
  History); always has Wallet (view-only) and Daily Report. The only
  thing a team member can never do is manage the team.
- **Dispatch admin** — a login with its own position and permissions
  checklist (Orders / Inventory / Stores / Admin Team / Withdrawals /
  Expenses); Report access is always included. Full visibility across
  every store within whatever it's permitted to see, with a
  "never miss an order" popup + manual check button on login.

### Local development

```
mysql -u root your_db < sql/schema.sql
mysql -u root your_db < sql/migration_002_v2_features.sql
cp public/config/config.sample.php public/config/config.php   # then fill in DB credentials
cd public && php -S 127.0.0.1:8099
```

Then visit `http://127.0.0.1:8099/setup.php` once to create your first
dispatch admin login (see `docs/DEPLOY.md` for details).
