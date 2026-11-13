# Silfab Procure

Purchase orders with a full version history and point-in-time views.

**Home page:** https://tootallted.github.io/silfabprocure/

All work with purchase order data happens on that page. The site is static and hosted on GitHub Pages. Data lives in a Supabase (Postgres) database, and the database only accepts reads and writes through the `po_*` functions in [`supabase/schema.sql`](supabase/schema.sql). A request must come from a signed-in user whose email is on the access list.

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

1. **Supabase project**: create one at https://supabase.com (the free tier is fine).
2. **Database**: open *SQL Editor*, paste the contents of `supabase/schema.sql`, and run it. It is safe to re-run after updates.
3. **Auth settings** (*Authentication → Sign In / Providers* and *URL Configuration*):
   - Turn **off** "Allow new users to sign up".
   - Set **Site URL** to `https://tootallted.github.io/silfabprocure/` and add the same URL under **Redirect URLs**.
4. **Connect the site**: copy *Project URL* and the *anon public* key (*Project Settings → API*) into `config.js`.
5. **GitHub Pages**: in repo *Settings → Pages*, choose *Deploy from a branch*, then `main` and `/ (root)`.

## Giving someone access

Both steps are required:

1. Supabase *Authentication → Users → Add user → Send invitation* to their email.
2. In the SQL Editor, run:
   ```sql
   insert into procure.app_user (email) values ('person@company.com');
   ```

To remove access, delete the row from `procure.app_user`. Their history stays in the audit trail.

Supabase's built-in email sender is rate-limited to a few emails per hour. For regular use, set up custom SMTP under *Authentication → Emails*.

## Development

```bash
npm install
npm test        # runs schema.sql in an in-process Postgres (PGlite) and tests every rule above
npm run serve   # serves the site at http://localhost:8490 (it uses whatever config.js points to)
```
