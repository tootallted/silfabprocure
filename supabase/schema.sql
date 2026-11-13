-- =====================================================================
-- Silfab Procure: purchase orders with fully auditable versioning
-- Run this whole file once in the Supabase SQL editor (safe to re-run).
--
-- Design
--   * Tables live in schema "procure", which the Supabase API does not
--     expose. The browser can reach data only through the po_* functions
--     in "public". Those functions check that the signed-in user is on the
--     procure.app_user allow-list.
--   * purchase_order / purchase_order_line hold current state.
--     changeset, *_version, audit_field_change and changeset_seal are
--     append-only history. Triggers reject UPDATE/DELETE, even from admins.
--   * Every save is sealed with a SHA-256 hash chained to the previous
--     save; po_verify_audit() recomputes the chain to detect tampering.
-- =====================================================================

create schema if not exists procure;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
create table if not exists procure.app_user (
  email    text primary key check (email = lower(email)),
  added_at timestamptz not null default now()
);

create table if not exists procure.purchase_order (
  id             bigint primary key,
  po_number      text not null unique,
  name           text not null,
  entered_at     timestamptz not null,          -- actual entry time, immutable
  effective_date date not null,                 -- user-assignable business date
  version        integer not null,
  updated_at     timestamptz not null
);

create table if not exists procure.purchase_order_line (
  id          bigint generated always as identity primary key,
  po_id       bigint not null references procure.purchase_order(id),
  line_number integer not null,
  description text,
  due_date    date,
  quantity    numeric(18,4) not null check (quantity > 0),
  unit_cost   numeric(18,4) not null check (unit_cost >= 0),
  line_total  numeric(20,2) generated always as (round(quantity * unit_cost, 2)) stored,
  is_active   boolean not null default true,
  version     integer not null,
  updated_at  timestamptz not null,
  unique (po_id, line_number)
);

create table if not exists procure.changeset (
  id       bigint generated always as identity primary key,
  po_id    bigint not null references procure.purchase_order(id),
  action   text not null check (action in ('create', 'update')),
  saved_at timestamptz not null,
  saved_by text not null,
  note     text
);
create index if not exists ix_changeset_po on procure.changeset (po_id, saved_at);

create table if not exists procure.purchase_order_version (
  po_id          bigint not null references procure.purchase_order(id),
  version        integer not null,
  changeset_id   bigint not null references procure.changeset(id),
  name           text not null,
  effective_date date not null,
  valid_from     timestamptz not null,
  primary key (po_id, version)
);

create table if not exists procure.purchase_order_line_version (
  line_id      bigint not null references procure.purchase_order_line(id),
  version      integer not null,
  po_id        bigint not null references procure.purchase_order(id),
  line_number  integer not null,
  changeset_id bigint not null references procure.changeset(id),
  description  text,
  due_date     date,
  quantity     numeric(18,4) not null,
  unit_cost    numeric(18,4) not null,
  line_total   numeric(20,2) generated always as (round(quantity * unit_cost, 2)) stored,
  is_active    boolean not null,
  valid_from   timestamptz not null,
  primary key (line_id, version)
);
create index if not exists ix_line_version_po on procure.purchase_order_line_version (po_id, valid_from);

create table if not exists procure.audit_field_change (
  id           bigint generated always as identity primary key,
  changeset_id bigint not null references procure.changeset(id),
  entity       text not null check (entity in ('header', 'line')),
  entity_id    bigint not null,
  line_number  integer,
  version      integer not null,
  field        text not null,
  old_value    text,
  new_value    text
);
create index if not exists ix_field_change_cs on procure.audit_field_change (changeset_id);

create table if not exists procure.changeset_seal (
  changeset_id bigint primary key references procure.changeset(id),
  prev_hash    text not null,
  hash         text not null
);

-- ---------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------
create or replace function procure.reject_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;

create or replace function procure.guard_purchase_order() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'purchase orders cannot be deleted';
  end if;
  if new.po_number is distinct from old.po_number or new.entered_at is distinct from old.entered_at then
    raise exception 'po_number and entered_at are immutable';
  end if;
  return new;
end $$;

create or replace function procure.guard_line_delete() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'purchase order lines cannot be deleted; deactivate them instead';
end $$;

drop trigger if exists guard on procure.purchase_order;
create trigger guard before update or delete on procure.purchase_order
  for each row execute function procure.guard_purchase_order();
drop trigger if exists no_delete on procure.purchase_order_line;
create trigger no_delete before delete on procure.purchase_order_line
  for each row execute function procure.guard_line_delete();

do $$
declare t text;
begin
  foreach t in array array['changeset', 'purchase_order_version', 'purchase_order_line_version',
                           'audit_field_change', 'changeset_seal'] loop
    execute format('drop trigger if exists append_only on procure.%I', t);
    execute format('create trigger append_only before update or delete on procure.%I
                    for each row execute function procure.reject_change()', t);
    execute format('drop trigger if exists append_only_truncate on procure.%I', t);
    execute format('create trigger append_only_truncate before truncate on procure.%I
                    for each statement execute function procure.reject_change()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Private helpers (not callable through the API)
-- ---------------------------------------------------------------------
create or replace function procure.fail(p_status int, p_message text, p_detail text default null) returns void
language plpgsql set search_path = '' as $$
begin
  -- PostgREST turns SQLSTATE 'PTnnn' into HTTP status nnn.
  raise exception using errcode = 'PT' || p_status::text, message = p_message, detail = coalesce(p_detail, '');
end $$;

create or replace function procure.require_actor() returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_email text := lower(nullif(auth.jwt() ->> 'email', ''));
begin
  if v_email is null then
    perform procure.fail(401, 'Sign in to use this app');
  end if;
  if not exists (select 1 from procure.app_user where email = v_email) then
    perform procure.fail(403, v_email || ' is not authorized for this app. Ask an administrator to add you.');
  end if;
  return v_email;
end $$;

create or replace function procure.clean_text(p_value text, p_field text, p_required boolean, p_max int) returns text
language plpgsql immutable set search_path = '' as $$
declare v text := nullif(btrim(coalesce(p_value, '')), '');
begin
  if v is null and p_required then perform procure.fail(400, p_field || ' is required'); end if;
  if length(v) > p_max then perform procure.fail(400, p_field || ' must be at most ' || p_max || ' characters'); end if;
  return v;
end $$;

create or replace function procure.clean_date(p_value text, p_field text, p_required boolean) returns date
language plpgsql immutable set search_path = '' as $$
declare d date;
begin
  if nullif(btrim(coalesce(p_value, '')), '') is null then
    if p_required then perform procure.fail(400, p_field || ' is required'); end if;
    return null;
  end if;
  if p_value !~ '^\d{4}-\d{2}-\d{2}$' then
    perform procure.fail(400, p_field || ' must be a valid date (YYYY-MM-DD)');
  end if;
  begin
    d := p_value::date;
  exception when others then
    perform procure.fail(400, p_field || ' must be a valid date (YYYY-MM-DD)');
  end;
  if to_char(d, 'YYYY-MM-DD') <> p_value then
    perform procure.fail(400, p_field || ' must be a valid date (YYYY-MM-DD)');
  end if;
  return d;
end $$;

-- p_strict_positive: true -> must be > 0, false -> must be >= 0
create or replace function procure.clean_num(p_value text, p_field text, p_strict_positive boolean) returns numeric
language plpgsql immutable set search_path = '' as $$
declare n numeric;
begin
  if nullif(btrim(coalesce(p_value, '')), '') is null then perform procure.fail(400, p_field || ' is required'); end if;
  begin
    n := btrim(p_value)::numeric;
  exception when others then
    perform procure.fail(400, p_field || ' must be a number');
  end;
  if n = 'NaN'::numeric then perform procure.fail(400, p_field || ' must be a number'); end if;
  if p_strict_positive and n <= 0 then perform procure.fail(400, p_field || ' must be greater than 0'); end if;
  if not p_strict_positive and n < 0 then perform procure.fail(400, p_field || ' must be at least 0'); end if;
  if n > 1000000000 then perform procure.fail(400, p_field || ' is too large'); end if;
  return round(n, 4);
end $$;

create or replace function procure.to_int(p_value text) returns bigint
language sql immutable set search_path = '' as $$
  select case when btrim(coalesce(p_value, '')) ~ '^-?\d{1,18}$' then btrim(p_value)::bigint end
$$;

-- Strictly increasing, millisecond-precision save time.
create or replace function procure.next_ts() returns timestamptz
language sql volatile set search_path = '' as $$
  select greatest(date_trunc('milliseconds', clock_timestamp()),
                  coalesce(max(saved_at), '-infinity'::timestamptz) + interval '1 millisecond')
  from procure.changeset
$$;

create or replace function procure.log_change(p_cs bigint, p_entity text, p_entity_id bigint, p_line int,
                                              p_version int, p_field text, p_old text, p_new text) returns void
language sql volatile set search_path = '' as $$
  insert into procure.audit_field_change (changeset_id, entity, entity_id, line_number, version, field, old_value, new_value)
  values (p_cs, p_entity, p_entity_id, p_line, p_version, p_field, p_old, p_new)
$$;

create or replace function procure.bool_text(b boolean) returns text
language sql immutable set search_path = '' as $$ select case when b then '1' else '0' end $$;

-- Canonical content of one changeset (jsonb text is key-ordered and deterministic).
create or replace function procure.seal_payload(p_cs bigint) returns text
language sql stable set search_path = '' set timezone to 'UTC' as $$
  select jsonb_build_object(
    'cs', (select to_jsonb(c) from procure.changeset c where c.id = p_cs),
    'hv', coalesce((select jsonb_agg(jsonb_build_object('po_id', v.po_id, 'version', v.version, 'name', v.name,
                                                        'effective_date', v.effective_date, 'valid_from', v.valid_from)
                                     order by v.po_id, v.version)
                    from procure.purchase_order_version v where v.changeset_id = p_cs), '[]'::jsonb),
    'lv', coalesce((select jsonb_agg(jsonb_build_object('line_id', v.line_id, 'version', v.version, 'po_id', v.po_id,
                                                        'line_number', v.line_number, 'description', v.description,
                                                        'due_date', v.due_date, 'quantity', v.quantity, 'unit_cost', v.unit_cost,
                                                        'is_active', v.is_active, 'valid_from', v.valid_from)
                                     order by v.line_id, v.version)
                    from procure.purchase_order_line_version v where v.changeset_id = p_cs), '[]'::jsonb),
    'fc', coalesce((select jsonb_agg(jsonb_build_object('entity', f.entity, 'entity_id', f.entity_id, 'line_number', f.line_number,
                                                        'version', f.version, 'field', f.field,
                                                        'old_value', f.old_value, 'new_value', f.new_value)
                                     order by f.id)
                    from procure.audit_field_change f where f.changeset_id = p_cs), '[]'::jsonb)
  )::text
$$;

create or replace function procure.sha256_hex(p text) returns text
language sql immutable set search_path = '' as $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;

create or replace function procure.seal(p_cs bigint) returns void
language plpgsql volatile set search_path = '' set timezone to 'UTC' as $$
declare v_prev text;
begin
  select s.hash into v_prev from procure.changeset_seal s order by s.changeset_id desc limit 1;
  v_prev := coalesce(v_prev, repeat('0', 64));
  insert into procure.changeset_seal (changeset_id, prev_hash, hash)
  values (p_cs, v_prev, procure.sha256_hex(v_prev || E'\n' || procure.seal_payload(p_cs)));
end $$;

-- ---------------------------------------------------------------------
-- API: writes
-- ---------------------------------------------------------------------
create or replace function public.po_create(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' set timezone to 'UTC' as $$
declare
  v_actor text := procure.require_actor();
  v_name text; v_eff date; v_note text; v_lines jsonb;
  v_ts timestamptz; v_id bigint; v_po_number text; v_cs bigint;
  v_line jsonb; v_i int := 0; v_line_id bigint;
  v_desc text; v_due date; v_qty numeric; v_cost numeric;
begin
  perform pg_advisory_xact_lock(hashtext('procure.save'));  -- one save at a time keeps the hash chain linear
  if p is null or jsonb_typeof(p) <> 'object' then perform procure.fail(400, 'Request body is required'); end if;
  v_name := procure.clean_text(p ->> 'name', 'Name', true, 200);
  v_eff  := procure.clean_date(p ->> 'effective_date', 'Effective date', false);
  v_note := procure.clean_text(p ->> 'note', 'Change note', false, 500);
  v_lines := p -> 'lines';
  if v_lines is null or jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) < 1 then
    perform procure.fail(400, 'At least one line is required');
  end if;
  if jsonb_array_length(v_lines) > 100 then
    perform procure.fail(400, 'A purchase order can have at most 100 lines');
  end if;

  v_ts := procure.next_ts();
  select coalesce(max(id), 0) + 1 into v_id from procure.purchase_order;
  v_po_number := 'PO-' || lpad(v_id::text, 6, '0');
  v_eff := coalesce(v_eff, (v_ts at time zone 'UTC')::date);

  insert into procure.purchase_order (id, po_number, name, entered_at, effective_date, version, updated_at)
  values (v_id, v_po_number, v_name, v_ts, v_eff, 1, v_ts);
  insert into procure.changeset (po_id, action, saved_at, saved_by, note)
  values (v_id, 'create', v_ts, v_actor, v_note) returning id into v_cs;
  insert into procure.purchase_order_version (po_id, version, changeset_id, name, effective_date, valid_from)
  values (v_id, 1, v_cs, v_name, v_eff, v_ts);
  perform procure.log_change(v_cs, 'header', v_id, null, 1, 'name', null, v_name);
  perform procure.log_change(v_cs, 'header', v_id, null, 1, 'effective_date', null, v_eff::text);

  for v_line in select value from jsonb_array_elements(v_lines) loop
    v_i := v_i + 1;
    v_desc := procure.clean_text(v_line ->> 'description', 'Line ' || v_i || ' description', false, 500);
    v_due  := procure.clean_date(v_line ->> 'due_date', 'Line ' || v_i || ' due date', false);
    v_qty  := procure.clean_num(v_line ->> 'quantity', 'Line ' || v_i || ' quantity', true);
    v_cost := procure.clean_num(v_line ->> 'unit_cost', 'Line ' || v_i || ' unit cost', false);
    insert into procure.purchase_order_line (po_id, line_number, description, due_date, quantity, unit_cost, is_active, version, updated_at)
    values (v_id, v_i, v_desc, v_due, v_qty, v_cost, true, 1, v_ts) returning id into v_line_id;
    insert into procure.purchase_order_line_version
      (line_id, version, po_id, line_number, changeset_id, description, due_date, quantity, unit_cost, is_active, valid_from)
    values (v_line_id, 1, v_id, v_i, v_cs, v_desc, v_due, v_qty, v_cost, true, v_ts);
    if v_desc is not null then perform procure.log_change(v_cs, 'line', v_line_id, v_i, 1, 'description', null, v_desc); end if;
    if v_due  is not null then perform procure.log_change(v_cs, 'line', v_line_id, v_i, 1, 'due_date', null, v_due::text); end if;
    perform procure.log_change(v_cs, 'line', v_line_id, v_i, 1, 'quantity', null, v_qty::text);
    perform procure.log_change(v_cs, 'line', v_line_id, v_i, 1, 'unit_cost', null, v_cost::text);
  end loop;

  perform procure.seal(v_cs);
  return jsonb_build_object('id', v_id, 'po_number', v_po_number, 'changeset_id', v_cs, 'saved_at', v_ts);
end $$;

-- Save edits. Only the header and the lines whose values changed get a new version.
-- p: { base_version, name, effective_date, note?,
--      lines: [{ id?, base_version?, description, due_date, quantity, unit_cost, removed? }] }
create or replace function public.po_update(p_id bigint, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' set timezone to 'UTC' as $$
declare
  v_actor text := procure.require_actor();
  v_po procure.purchase_order;
  v_cur procure.purchase_order_line;
  v_name text; v_eff date; v_note text;
  v_raw jsonb; v_seen bigint[] := '{}';
  v_active boolean; v_desc text; v_due date; v_qty numeric; v_cost numeric;
  v_next_num int; v_new_idx int := 0; v_line_id bigint; v_v int;
  v_ts timestamptz; v_cs bigint;
  v_header_version int; v_header_changed boolean := false;
  v_lines_changed int := 0; v_lines_added int := 0; v_active_after int;
begin
  perform pg_advisory_xact_lock(hashtext('procure.save'));
  if p is null or jsonb_typeof(p) <> 'object' then perform procure.fail(400, 'Request body is required'); end if;
  select * into v_po from procure.purchase_order where id = p_id for update;
  if not found then perform procure.fail(404, 'Purchase order not found'); end if;
  if procure.to_int(p ->> 'base_version') is distinct from v_po.version then
    perform procure.fail(409, v_po.po_number || ' header was changed by another save (now v' || v_po.version || '). Reload to see the latest.');
  end if;
  v_name := procure.clean_text(p ->> 'name', 'Name', true, 200);
  v_eff  := procure.clean_date(p ->> 'effective_date', 'Effective date', true);
  v_note := procure.clean_text(p ->> 'note', 'Change note', false, 500);
  v_header_version := v_po.version;

  -- Header
  if v_name is distinct from v_po.name or v_eff is distinct from v_po.effective_date then
    v_ts := procure.next_ts();
    insert into procure.changeset (po_id, action, saved_at, saved_by, note)
    values (p_id, 'update', v_ts, v_actor, v_note) returning id into v_cs;
    v_header_changed := true;
    v_header_version := v_po.version + 1;
    update procure.purchase_order set name = v_name, effective_date = v_eff, version = v_header_version, updated_at = v_ts
    where id = p_id;
    insert into procure.purchase_order_version (po_id, version, changeset_id, name, effective_date, valid_from)
    values (p_id, v_header_version, v_cs, v_name, v_eff, v_ts);
    if v_name is distinct from v_po.name then
      perform procure.log_change(v_cs, 'header', p_id, null, v_header_version, 'name', v_po.name, v_name);
    end if;
    if v_eff is distinct from v_po.effective_date then
      perform procure.log_change(v_cs, 'header', p_id, null, v_header_version, 'effective_date', v_po.effective_date::text, v_eff::text);
    end if;
  end if;

  -- Lines
  select coalesce(max(line_number), 0) + 1 into v_next_num from procure.purchase_order_line where po_id = p_id;
  if p -> 'lines' is not null and jsonb_typeof(p -> 'lines') <> 'array' then
    perform procure.fail(400, 'lines must be a list');
  end if;
  for v_raw in select value from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
    if jsonb_typeof(v_raw) <> 'object' then perform procure.fail(400, 'Each line must be an object'); end if;
    if coalesce(jsonb_typeof(v_raw -> 'id'), 'null') <> 'null' then
      select * into v_cur from procure.purchase_order_line
      where id = procure.to_int(v_raw ->> 'id') and po_id = p_id for update;
      if not found then perform procure.fail(400, 'Line id ' || (v_raw ->> 'id') || ' does not belong to ' || v_po.po_number); end if;
      if v_cur.id = any(v_seen) then perform procure.fail(400, 'Line ' || v_cur.line_number || ' appears more than once'); end if;
      v_seen := v_seen || v_cur.id;
      if procure.to_int(v_raw ->> 'base_version') is distinct from v_cur.version then
        perform procure.fail(409, 'Line ' || v_cur.line_number || ' was changed by another save (now v' || v_cur.version || '). Reload to see the latest.');
      end if;
      v_active := not coalesce((v_raw ->> 'removed') = 'true', false);
      if v_active then
        v_desc := procure.clean_text(v_raw ->> 'description', 'Line ' || v_cur.line_number || ' description', false, 500);
        v_due  := procure.clean_date(v_raw ->> 'due_date', 'Line ' || v_cur.line_number || ' due date', false);
        v_qty  := procure.clean_num(v_raw ->> 'quantity', 'Line ' || v_cur.line_number || ' quantity', true);
        v_cost := procure.clean_num(v_raw ->> 'unit_cost', 'Line ' || v_cur.line_number || ' unit cost', false);
      else  -- a removed line keeps its last values
        v_desc := v_cur.description; v_due := v_cur.due_date; v_qty := v_cur.quantity; v_cost := v_cur.unit_cost;
      end if;
      if v_desc is distinct from v_cur.description or v_due is distinct from v_cur.due_date
         or v_qty is distinct from v_cur.quantity or v_cost is distinct from v_cur.unit_cost
         or v_active is distinct from v_cur.is_active then
        if v_cs is null then
          v_ts := procure.next_ts();
          insert into procure.changeset (po_id, action, saved_at, saved_by, note)
          values (p_id, 'update', v_ts, v_actor, v_note) returning id into v_cs;
        end if;
        v_v := v_cur.version + 1;
        update procure.purchase_order_line
        set description = v_desc, due_date = v_due, quantity = v_qty, unit_cost = v_cost,
            is_active = v_active, version = v_v, updated_at = v_ts
        where id = v_cur.id;
        insert into procure.purchase_order_line_version
          (line_id, version, po_id, line_number, changeset_id, description, due_date, quantity, unit_cost, is_active, valid_from)
        values (v_cur.id, v_v, p_id, v_cur.line_number, v_cs, v_desc, v_due, v_qty, v_cost, v_active, v_ts);
        if v_desc is distinct from v_cur.description then
          perform procure.log_change(v_cs, 'line', v_cur.id, v_cur.line_number, v_v, 'description', v_cur.description, v_desc); end if;
        if v_due is distinct from v_cur.due_date then
          perform procure.log_change(v_cs, 'line', v_cur.id, v_cur.line_number, v_v, 'due_date', v_cur.due_date::text, v_due::text); end if;
        if v_qty is distinct from v_cur.quantity then
          perform procure.log_change(v_cs, 'line', v_cur.id, v_cur.line_number, v_v, 'quantity', v_cur.quantity::text, v_qty::text); end if;
        if v_cost is distinct from v_cur.unit_cost then
          perform procure.log_change(v_cs, 'line', v_cur.id, v_cur.line_number, v_v, 'unit_cost', v_cur.unit_cost::text, v_cost::text); end if;
        if v_active is distinct from v_cur.is_active then
          perform procure.log_change(v_cs, 'line', v_cur.id, v_cur.line_number, v_v, 'is_active',
                                     procure.bool_text(v_cur.is_active), procure.bool_text(v_active)); end if;
        v_lines_changed := v_lines_changed + 1;
      end if;
    elsif not coalesce((v_raw ->> 'removed') = 'true', false) then
      v_new_idx := v_new_idx + 1;
      v_desc := procure.clean_text(v_raw ->> 'description', 'New line ' || v_new_idx || ' description', false, 500);
      v_due  := procure.clean_date(v_raw ->> 'due_date', 'New line ' || v_new_idx || ' due date', false);
      v_qty  := procure.clean_num(v_raw ->> 'quantity', 'New line ' || v_new_idx || ' quantity', true);
      v_cost := procure.clean_num(v_raw ->> 'unit_cost', 'New line ' || v_new_idx || ' unit cost', false);
      if v_cs is null then
        v_ts := procure.next_ts();
        insert into procure.changeset (po_id, action, saved_at, saved_by, note)
        values (p_id, 'update', v_ts, v_actor, v_note) returning id into v_cs;
      end if;
      insert into procure.purchase_order_line (po_id, line_number, description, due_date, quantity, unit_cost, is_active, version, updated_at)
      values (p_id, v_next_num, v_desc, v_due, v_qty, v_cost, true, 1, v_ts) returning id into v_line_id;
      insert into procure.purchase_order_line_version
        (line_id, version, po_id, line_number, changeset_id, description, due_date, quantity, unit_cost, is_active, valid_from)
      values (v_line_id, 1, p_id, v_next_num, v_cs, v_desc, v_due, v_qty, v_cost, true, v_ts);
      if v_desc is not null then perform procure.log_change(v_cs, 'line', v_line_id, v_next_num, 1, 'description', null, v_desc); end if;
      if v_due  is not null then perform procure.log_change(v_cs, 'line', v_line_id, v_next_num, 1, 'due_date', null, v_due::text); end if;
      perform procure.log_change(v_cs, 'line', v_line_id, v_next_num, 1, 'quantity', null, v_qty::text);
      perform procure.log_change(v_cs, 'line', v_line_id, v_next_num, 1, 'unit_cost', null, v_cost::text);
      v_next_num := v_next_num + 1;
      v_lines_added := v_lines_added + 1;
    end if;
  end loop;

  select count(*) into v_active_after from procure.purchase_order_line where po_id = p_id and is_active;
  if v_active_after < 1 then perform procure.fail(400, 'A purchase order must keep at least one line'); end if;
  if v_active_after > 100 then perform procure.fail(400, 'A purchase order can have at most 100 lines'); end if;

  if v_cs is null then
    return jsonb_build_object('changed', false, 'id', p_id, 'po_number', v_po.po_number);
  end if;
  perform procure.seal(v_cs);
  return jsonb_build_object('changed', true, 'id', p_id, 'po_number', v_po.po_number, 'changeset_id', v_cs,
                            'saved_at', v_ts, 'header_version', v_header_version, 'header_changed', v_header_changed,
                            'lines_changed', v_lines_changed, 'lines_added', v_lines_added);
end $$;

-- ---------------------------------------------------------------------
-- API: reads (p_as_of null = latest)
-- ---------------------------------------------------------------------
create or replace function public.po_list(p_as_of timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = '' set timezone to 'UTC' as $$
declare t timestamptz := coalesce(p_as_of, 'infinity'::timestamptz); v jsonb;
begin
  perform procure.require_actor();
  with h as (
    select distinct on (po_id) * from procure.purchase_order_version
    where valid_from <= t order by po_id, version desc
  ), l as (
    select distinct on (line_id) * from procure.purchase_order_line_version
    where valid_from <= t order by line_id, version desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', po.id, 'po_number', po.po_number, 'entered_at', po.entered_at,
           'name', h.name, 'effective_date', h.effective_date, 'version', h.version, 'updated_at', h.valid_from,
           'line_count', (select count(*) from l where l.po_id = po.id and l.is_active),
           'total', (select coalesce(sum(l.line_total), 0) from l where l.po_id = po.id and l.is_active))
         order by po.id desc), '[]'::jsonb)
  into v
  from h join procure.purchase_order po on po.id = h.po_id;
  return v;
end $$;

create or replace function public.po_get(p_id bigint, p_as_of timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = '' set timezone to 'UTC' as $$
declare
  t timestamptz := coalesce(p_as_of, 'infinity'::timestamptz);
  v_po procure.purchase_order;
  v_headers jsonb; v_lines jsonb; v_audit jsonb; v_total numeric;
begin
  perform procure.require_actor();
  select * into v_po from procure.purchase_order where id = p_id;
  if not found then perform procure.fail(404, 'Purchase order not found'); end if;

  select jsonb_agg(jsonb_build_object('version', v.version, 'name', v.name, 'effective_date', v.effective_date,
                                      'valid_from', v.valid_from, 'changeset_id', v.changeset_id, 'saved_by', c.saved_by)
                   order by v.version desc)
  into v_headers
  from procure.purchase_order_version v join procure.changeset c on c.id = v.changeset_id
  where v.po_id = p_id and v.valid_from <= t;
  if v_headers is null then
    perform procure.fail(404, v_po.po_number || ' had not been entered yet at that time', to_jsonb(v_po.entered_at) #>> '{}');
  end if;

  with lv as (
    select v.*, c.saved_by from procure.purchase_order_line_version v
    join procure.changeset c on c.id = v.changeset_id
    where v.po_id = p_id and v.valid_from <= t
  ), g as (
    select line_id, min(line_number) as ln,
           jsonb_agg(jsonb_build_object('line_id', line_id, 'version', version, 'line_number', line_number,
                                        'description', description, 'due_date', due_date, 'quantity', quantity,
                                        'unit_cost', unit_cost, 'line_total', line_total, 'is_active', is_active,
                                        'valid_from', valid_from, 'changeset_id', changeset_id, 'saved_by', saved_by)
                     order by version desc) as versions
    from lv group by line_id
  )
  select jsonb_agg((versions -> 0) || jsonb_build_object('id', line_id, 'history', versions - 0) order by ln)
  into v_lines from g;
  v_lines := coalesce(v_lines, '[]'::jsonb);

  select coalesce(sum((x ->> 'line_total')::numeric), 0) into v_total
  from jsonb_array_elements(v_lines) x where (x ->> 'is_active')::boolean;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'action', c.action, 'saved_at', c.saved_at, 'saved_by', c.saved_by, 'note', c.note,
           'changes', coalesce((select jsonb_agg(jsonb_build_object(
                                  'changeset_id', f.changeset_id, 'entity', f.entity, 'entity_id', f.entity_id,
                                  'line_number', f.line_number, 'version', f.version, 'field', f.field,
                                  'old_value', f.old_value, 'new_value', f.new_value) order by f.id)
                                from procure.audit_field_change f where f.changeset_id = c.id), '[]'::jsonb))
         order by c.id desc), '[]'::jsonb)
  into v_audit
  from procure.changeset c where c.po_id = p_id and c.saved_at <= t;

  return jsonb_build_object(
    'id', v_po.id, 'po_number', v_po.po_number, 'entered_at', v_po.entered_at,
    'as_of', p_as_of, 'header', v_headers -> 0, 'header_history', v_headers - 0,
    'lines', v_lines, 'total', v_total, 'audit', v_audit, 'max_lines', 100);
end $$;

create or replace function public.po_timeline() returns jsonb
language plpgsql stable security definer set search_path = '' set timezone to 'UTC' as $$
declare v jsonb;
begin
  perform procure.require_actor();
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'po_id', c.po_id, 'po_number', po.po_number, 'action', c.action,
                                               'saved_at', c.saved_at, 'saved_by', c.saved_by, 'note', c.note)
                            order by c.id), '[]'::jsonb)
  into v
  from procure.changeset c join procure.purchase_order po on po.id = c.po_id;
  return v;
end $$;

-- Recompute the SHA-256 chain over every changeset and compare with the stored seals.
create or replace function public.po_verify_audit() returns jsonb
language plpgsql stable security definer set search_path = '' set timezone to 'UTC' as $$
declare
  v_prev text := repeat('0', 64);
  v_count int := 0;
  r record;
begin
  perform procure.require_actor();
  for r in select c.id, s.prev_hash, s.hash from procure.changeset c
           left join procure.changeset_seal s on s.changeset_id = c.id order by c.id loop
    if r.hash is null or r.prev_hash is distinct from v_prev
       or r.hash <> procure.sha256_hex(v_prev || E'\n' || procure.seal_payload(r.id)) then
      return jsonb_build_object('ok', false, 'count', v_count, 'broken_at_changeset', r.id);
    end if;
    v_prev := r.hash;
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('ok', true, 'count', v_count, 'head', v_prev);
end $$;

-- Who am I, and am I on the allow-list? (Never raises, so the page can explain access.)
create or replace function public.po_whoami() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'email', lower(nullif(auth.jwt() ->> 'email', '')),
    'allowed', exists (select 1 from procure.app_user u where u.email = lower(nullif(auth.jwt() ->> 'email', ''))))
$$;

-- ---------------------------------------------------------------------
-- Lock down: no direct table access through the API, only the po_* functions,
-- and only for signed-in users.
-- ---------------------------------------------------------------------
alter table procure.app_user                    enable row level security;
alter table procure.purchase_order              enable row level security;
alter table procure.purchase_order_line         enable row level security;
alter table procure.changeset                   enable row level security;
alter table procure.purchase_order_version      enable row level security;
alter table procure.purchase_order_line_version enable row level security;
alter table procure.audit_field_change          enable row level security;
alter table procure.changeset_seal              enable row level security;

revoke all on schema procure from public, anon, authenticated;
revoke all on all tables in schema procure from public, anon, authenticated;
revoke all on all functions in schema procure from public, anon, authenticated;

revoke all on function public.po_create(jsonb)                  from public, anon;
revoke all on function public.po_update(bigint, jsonb)          from public, anon;
revoke all on function public.po_list(timestamptz)              from public, anon;
revoke all on function public.po_get(bigint, timestamptz)       from public, anon;
revoke all on function public.po_timeline()                     from public, anon;
revoke all on function public.po_verify_audit()                 from public, anon;
revoke all on function public.po_whoami()                       from public, anon;
grant execute on function public.po_create(jsonb)               to authenticated;
grant execute on function public.po_update(bigint, jsonb)       to authenticated;
grant execute on function public.po_list(timestamptz)           to authenticated;
grant execute on function public.po_get(bigint, timestamptz)    to authenticated;
grant execute on function public.po_timeline()                  to authenticated;
grant execute on function public.po_verify_audit()              to authenticated;
grant execute on function public.po_whoami()                    to authenticated;

-- ---------------------------------------------------------------------
-- Give someone access (run separately, once per person):
--   insert into procure.app_user (email) values ('person@example.com');
-- ---------------------------------------------------------------------
