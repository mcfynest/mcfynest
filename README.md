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

## Manifest — Dispatch & Order Management

A production dispatch/order management app for a logistics company and
the stores it delivers for: stores log stock drop-offs, raise delivery
orders against that stock, and a dispatch admin team tracks every order
through to delivery.

Plain PHP + MySQL (no Node.js, no build step) — built to run on standard
shared/cPanel hosting. Installable as a PWA on phones.

- **App code**: [`public/`](public/) — this folder's contents are what
  gets uploaded to your web host.
- **Database schema**: [`sql/schema.sql`](sql/schema.sql)
- **Deployment walkthrough**: [`docs/DEPLOY.md`](docs/DEPLOY.md) —
  step-by-step Namecheap cPanel setup (MySQL database, file upload,
  config, first admin login, HTTPS, PWA install).

### Roles
- **Store owner** — full access for their store: log stock drop-offs,
  raise orders, manage team logins.
- **Team member** — a login created by a store owner, restricted
  server-side to specific products only.
- **Dispatch admin** — full visibility across every store, with a
  "never miss an order" popup + manual check button on login.

### Local development

```
mysql -u root your_db < sql/schema.sql
cp public/config/config.sample.php public/config/config.php   # then fill in DB credentials
cd public && php -S 127.0.0.1:8099
```

Then visit `http://127.0.0.1:8099/setup.php` once to create your first
dispatch admin login (see `docs/DEPLOY.md` for details).
