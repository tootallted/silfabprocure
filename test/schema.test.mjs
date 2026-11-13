// Runs supabase/schema.sql in an in-process Postgres (PGlite) with small stand-ins for
// Supabase's auth.jwt() and API roles, then exercises the po_* functions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const schema = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
const SUPABASE_STUBS = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
  $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.jwt() to anon, authenticated;
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fresh(email = 'buyer@example.com') {
  const db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  await db.exec(schema);
  await db.exec(schema); // re-running must be safe
  await db.query("insert into procure.app_user (email) values ('buyer@example.com')");
  await signIn(db, email);
  return db;
}

async function signIn(db, email) {
  await db.query("select set_config('request.jwt.claims', $1, false)", [email ? JSON.stringify({ email }) : '']);
}

async function call(db, fn, args = []) {
  const ph = args.map((_, i) => `$${i + 1}`).join(', ');
  const r = await db.query(`select public.${fn}(${ph}) as v`, args);
  return r.rows[0].v;
}

async function rejects(promise, code, re) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    if (re) assert.match(e.message, re);
    return true;
  });
}

const create = (db, body) => call(db, 'po_create', [JSON.stringify(body)]);
const update = (db, id, body) => call(db, 'po_update', [id, JSON.stringify(body)]);
const get = (db, id, asOf = null) => call(db, 'po_get', [id, asOf]);

function linesFor(po, overrides = {}) {
  return po.lines.map((l) => ({
    id: l.id, base_version: l.version, description: l.description, due_date: l.due_date,
    quantity: l.quantity, unit_cost: l.unit_cost, removed: !l.is_active, ...(overrides[l.line_number] || {}),
  }));
}

test('create with minimum fields; totals and defaults', async () => {
  const db = await fresh();
  const r = await create(db, { name: 'Office chairs', lines: [{ quantity: 3, unit_cost: '19.99' }] });
  assert.equal(r.po_number, 'PO-000001');
  const po = await get(db, r.id);
  assert.equal(po.header.version, 1);
  assert.match(po.header.effective_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(po.lines[0].line_number, 1);
  assert.equal(Number(po.lines[0].line_total), 59.97);
  assert.equal(Number(po.total), 59.97);
  assert.equal(po.audit[0].saved_by, 'buyer@example.com');
});

test('validation and line limits', async () => {
  const db = await fresh();
  await rejects(create(db, { name: ' ', lines: [{ quantity: 1, unit_cost: 1 }] }), 'PT400', /Name is required/);
  await rejects(create(db, { name: 'x', lines: [] }), 'PT400', /At least one line/);
  await rejects(create(db, { name: 'x', effective_date: '2026-02-30', lines: [{ quantity: 1, unit_cost: 1 }] }), 'PT400', /valid date/);
  await rejects(create(db, { name: 'x', lines: [{ quantity: 0, unit_cost: 1 }] }), 'PT400', /greater than 0/);
  await rejects(create(db, { name: 'x', lines: [{ quantity: 1, unit_cost: 'abc' }] }), 'PT400', /must be a number/);
  const many = Array.from({ length: 101 }, () => ({ quantity: 1, unit_cost: 1 }));
  await rejects(create(db, { name: 'x', lines: many }), 'PT400', /at most 100/);
  const r = await create(db, { name: 'x', effective_date: '2031-01-15', lines: many.slice(0, 100) });
  const po = await get(db, r.id);
  assert.equal(po.lines.length, 100);
  assert.equal(po.header.effective_date, '2031-01-15');
  await rejects(update(db, r.id, { base_version: 1, name: 'x', effective_date: '2031-01-15', lines: [...linesFor(po), { quantity: 1, unit_cost: 1 }] }), 'PT400', /at most 100/);
  // failed save left nothing behind
  assert.equal((await call(db, 'po_timeline')).length, 1);
});

test('only changed header/lines are versioned; field-level audit', async () => {
  const db = await fresh();
  const r = await create(db, { name: 'Parts', lines: [{ quantity: 1, unit_cost: 10 }, { quantity: 2, unit_cost: 5 }] });
  let po = await get(db, r.id);
  const eff = po.header.effective_date;
  assert.equal((await update(db, r.id, { base_version: 1, name: 'Parts', effective_date: eff, lines: linesFor(po) })).changed, false);

  const u1 = await update(db, r.id, { base_version: 1, name: 'Parts', effective_date: eff, lines: linesFor(po, { 2: { unit_cost: 7.5 } }) });
  assert.deepEqual([u1.header_changed, u1.lines_changed], [false, 1]);
  po = await get(db, r.id);
  assert.deepEqual(po.lines.map((l) => l.version), [1, 2]);
  assert.equal(Number(po.lines[1].history[0].unit_cost), 5);

  await update(db, r.id, { base_version: 1, name: 'Spare parts', effective_date: '2026-01-01', lines: linesFor(po) });
  po = await get(db, r.id);
  assert.equal(po.header.version, 2);
  assert.equal(po.header_history[0].name, 'Parts');
  assert.deepEqual(po.lines.map((l) => l.version), [1, 2]);
  assert.deepEqual(po.audit[0].changes.map((c) => [c.field, c.old_value, c.new_value]), [
    ['name', 'Parts', 'Spare parts'], ['effective_date', eff, '2026-01-01'],
  ]);
});

test('remove, add and restore lines; minimum one line', async () => {
  const db = await fresh();
  const r = await create(db, { name: 'P', lines: [{ quantity: 1, unit_cost: 1 }, { quantity: 1, unit_cost: 2 }] });
  let po = await get(db, r.id);
  const eff = po.header.effective_date;
  await update(db, r.id, { base_version: 1, name: 'P', effective_date: eff, lines: [...linesFor(po, { 2: { removed: true } }), { quantity: 4, unit_cost: 3, due_date: '2026-12-01' }] });
  po = await get(db, r.id);
  assert.deepEqual(po.lines.map((l) => [l.line_number, l.version, l.is_active]), [[1, 1, true], [2, 2, false], [3, 1, true]]);
  assert.equal(Number(po.total), 13);
  await rejects(update(db, r.id, { base_version: 1, name: 'P', effective_date: eff, lines: linesFor(po, { 1: { removed: true }, 3: { removed: true } }) }), 'PT400', /at least one line/);
  await update(db, r.id, { base_version: 1, name: 'P', effective_date: eff, lines: linesFor(po, { 2: { removed: false } }) });
  po = await get(db, r.id);
  assert.deepEqual(po.lines.map((l) => [l.line_number, l.version, l.is_active]), [[1, 1, true], [2, 3, true], [3, 1, true]]);
});

test('stale versions are rejected', async () => {
  const db = await fresh();
  const r = await create(db, { name: 'P', lines: [{ quantity: 1, unit_cost: 1 }] });
  const po = await get(db, r.id);
  const eff = po.header.effective_date;
  await update(db, r.id, { base_version: 1, name: 'P2', effective_date: eff, lines: linesFor(po) });
  await rejects(update(db, r.id, { base_version: 1, name: 'P3', effective_date: eff, lines: linesFor(po) }), 'PT409');
  await update(db, r.id, { base_version: 2, name: 'P2', effective_date: eff, lines: linesFor(po, { 1: { quantity: 5 } }) });
  await rejects(update(db, r.id, { base_version: 2, name: 'P2', effective_date: eff, lines: linesFor(po, { 1: { quantity: 6 } }) }), 'PT409', /Line 1/);
});

test('point-in-time reads', async () => {
  const db = await fresh();
  const r = await create(db, { name: 'v1 name', lines: [{ quantity: 1, unit_cost: 100 }] });
  const t1 = (await call(db, 'po_timeline'))[0].saved_at;
  await sleep(5);
  let po = await get(db, r.id);
  await update(db, r.id, { base_version: 1, name: 'v2 name', effective_date: po.header.effective_date, lines: [...linesFor(po, { 1: { unit_cost: 150 } }), { quantity: 2, unit_cost: 1 }] });

  const asOf1 = new Date(Date.parse(t1)).toISOString(); // what the browser sends (ms precision)
  const then = await get(db, r.id, asOf1);
  assert.equal(then.header.name, 'v1 name');
  assert.equal(then.lines.length, 1);
  assert.equal(Number(then.total), 100);
  assert.equal(then.audit.length, 1);
  assert.equal(Number((await call(db, 'po_list', [asOf1]))[0].total), 100);

  po = await get(db, r.id);
  assert.equal(po.header.name, 'v2 name');
  assert.equal(Number(po.total), 152);
  assert.equal(Number((await call(db, 'po_list', [null]))[0].total), 152);

  const before = new Date(Date.parse(t1) - 1000).toISOString();
  assert.equal((await call(db, 'po_list', [before])).length, 0);
  await rejects(get(db, r.id, before), 'PT404', /not been entered yet/);
});

test('access: sign-in and allow-list required; tables not reachable by API roles', async () => {
  const db = await fresh();
  await create(db, { name: 'P', lines: [{ quantity: 1, unit_cost: 1 }] });

  await signIn(db, null);
  await rejects(call(db, 'po_list', [null]), 'PT401');
  await signIn(db, 'stranger@example.com');
  await rejects(call(db, 'po_list', [null]), 'PT403');
  assert.deepEqual(await call(db, 'po_whoami'), { email: 'stranger@example.com', allowed: false });
  await signIn(db, 'Buyer@Example.com');
  assert.equal((await call(db, 'po_whoami')).allowed, true);

  await db.exec('set role anon');
  await rejects(db.query('select public.po_list(null)'), '42501');
  await db.exec('reset role');
  await db.exec('set role authenticated');
  await rejects(db.query('select * from procure.purchase_order'), '42501');
  await rejects(db.query("insert into procure.app_user values ('me@x.com')"), '42501');
  assert.equal((await call(db, 'po_list', [null])).length, 1); // functions still work
  await db.exec('reset role');
});

test('history is append-only and the hash chain detects tampering', async () => {
  const db = await fresh();
  const r = await create(db, { name: 'P', lines: [{ quantity: 1, unit_cost: 1 }] });
  const po = await get(db, r.id);
  await update(db, r.id, { base_version: 1, name: 'P2', effective_date: po.header.effective_date, lines: linesFor(po) });
  const ok = await call(db, 'po_verify_audit');
  assert.deepEqual([ok.ok, ok.count], [true, 2]);

  await assert.rejects(db.query("update procure.purchase_order_version set name = 'hacked'"), /append-only/);
  await assert.rejects(db.query('delete from procure.changeset'), /append-only/);
  await assert.rejects(db.query('truncate procure.audit_field_change'), /append-only/);
  await assert.rejects(db.query('delete from procure.purchase_order'), /cannot be deleted/);
  await assert.rejects(db.query("update procure.purchase_order set entered_at = now() - interval '1 year'"), /immutable/);

  // An admin drops the guard and rewrites history: verification catches it.
  await db.exec('drop trigger append_only on procure.purchase_order_version');
  await db.query("update procure.purchase_order_version set name = 'hacked' where version = 1");
  const bad = await call(db, 'po_verify_audit');
  assert.deepEqual([bad.ok, bad.broken_at_changeset], [false, 1]);
});
