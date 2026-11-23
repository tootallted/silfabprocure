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

## Public access (GitHub Pages, Teams)

The page is published at https://tootallted.github.io/silfabprocure/ and in the Teams app. Its data calls reach this PC through a Cloudflare quick tunnel:

1. Start the server: `npm start`.
2. Start the tunnel: `npm run tunnel`. A quick tunnel gets a new `*.trycloudflare.com` address on each start, so the script writes it into `tunnel.json` and pushes it. GitHub Pages picks it up in about a minute.

Both windows must stay open, and the PC must stay on.

## Who can use it

People sign in with their Microsoft 365 work account. Inside Teams this happens automatically. The server checks every request's Microsoft Entra ID token (`AZURE_TENANT_ID` and `AZURE_CLIENT_ID` in `server/.env`) and uses the email in it. The app registration needs:

- SPA redirect URIs `https://tootallted.github.io/silfabprocure/` and `http://localhost:8490/`
- Application ID URI `api://tootallted.github.io/<client ID>`, with an `access_as_user` scope
- The Teams clients `1fec8e78-bce4-4aaf-ab1b-5451cc387264` and `5e3ce6c0-2b1f-4285-8d4b-75ee78787346` authorized for that scope

If `AZURE_*` is left empty, the server works on this PC only, with no sign-in, and records every save as `SILFAB_USER_EMAIL`.

The access list decides who gets in. To add or remove someone:

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
