-- One-time setup on the local PostgreSQL server. Run as the "postgres" admin account by
-- tools/setup-local-db.ps1, which passes the app password from server/.env as :app_pw.
-- Safe to re-run.
\set ON_ERROR_STOP on

-- The account the Silfab Procure server connects as. It owns the database but is not an admin.
select 'create role silfab_app login' where not exists (select 1 from pg_roles where rolname = 'silfab_app') \gexec
alter role silfab_app password :'app_pw';

-- Stand-ins for the two Supabase API roles that supabase/schema.sql grants to.
-- The server switches to "authenticated" for every request, so the po_* functions run
-- with the same limited rights they had on Supabase.
select 'create role anon nologin' where not exists (select 1 from pg_roles where rolname = 'anon') \gexec
select 'create role authenticated nologin' where not exists (select 1 from pg_roles where rolname = 'authenticated') \gexec
grant anon, authenticated to silfab_app;

select 'create database silfabprocure owner silfab_app' where not exists (select 1 from pg_database where datname = 'silfabprocure') \gexec
