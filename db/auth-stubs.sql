-- Replaces Supabase's auth.jwt(). The server sets request.jwt.claims for each request
-- (inside its transaction), so supabase/schema.sql runs unchanged on plain PostgreSQL.
-- Run before supabase/schema.sql. Safe to re-run.
create schema if not exists auth;

create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

grant usage on schema auth to anon, authenticated;
grant execute on function auth.jwt() to anon, authenticated;
