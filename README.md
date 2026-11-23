# Silfab Procure

Purchase orders with a full version history and point-in-time views.

**Open it:** http://localhost:8490/ on the PC that runs the server.

The site and its data run on one Windows PC. [`server/server.js`](server/server.js) serves the page and talks to a local PostgreSQL 17 database named `silfabprocure`. The database only accepts reads and writes through the `po_*` functions in [`supabase/schema.sql`](supabase/schema.sql). That folder keeps its name from when the data lived on Supabase. The same file runs unchanged on local PostgreSQL, with [`db/auth-stubs.sql`](db/auth-stubs.sql) standing in for Supabase's sign-in functions.

## What it does

- Create a PO with only a name and one line's unit cost. Number, entry timestamp and versions are assigned automatically. The effective date defaults to the entry date and can be backdated or future-dated.
- Each PO has 1–100 lines, each with a line number, due date, quantity, unit cost and a calculated line total.
- When you save, only the header and the lines you changed get a new version. Version numbers show in grey. Old versions can be shown or hidden.
- The time bar shows exactly what any PO said at any past moment. The page always opens on the latest data.
- The audit trail records who changed which field, when, and from what to what.

## How the audit trail is protected

- History tables (`changeset`, `purchase_order_version`, `purchase_order_line_version`, `audit_field_change`, `changeset_seal`) are append-only. Database triggers reject `UPDATE`, `DELETE` and `TRUNCATE`, even from administrators.
- Lines are never deleted. A removed line is saved as a new version marked removed.
- Every save is sealed with a SHA-256 hash chained to the previous save. The page header shows the result of re-checking the whole chain, which catches any edit made around the triggers.
- If someone else saved first, your save is rejected and nothing is overwritten.

## One-time setup

1. **PostgreSQL 17**, installed as a Windows service and listening on `localhost:5432`.
2. **Settings**: `server/.env` (not committed) holds the database connection and `SILFAB_USER_EMAIL`. Every save is recorded as that email, and it must be on the access list.
3. **Database and account**: run `tools/setup-local-db.ps1`. It asks for the local `postgres` admin password, then creates the `silfab_app` account and the `silfabprocure` database. The first time it ran, it also copied the old data out of Supabase into `local/` (not committed).
4. **Schema**: as `silfab_app`, run `db/auth-stubs.sql` and then `supabase/schema.sql`. Both are safe to re-run after updates.
5. **Start**: run `npm install`, then `npm start`, and open http://localhost:8490/.

## Who can use it

The server listens on this PC only (`127.0.0.1`) and has no sign-in. Anyone using a browser on this PC acts as `SILFAB_USER_EMAIL`. Before other people or Microsoft Teams can reach it, it needs a sign-in and HTTPS hosting.

The access list is still enforced. To add or remove someone:

```sql
insert into procure.app_user (email) values ('person@company.com');
delete from procure.app_user where email = 'person@company.com';  -- their history stays in the audit trail
```

## Development

```bash
npm install
npm test     # runs schema.sql in an in-process Postgres (PGlite) and tests every rule above
npm start    # http://localhost:8490
```
