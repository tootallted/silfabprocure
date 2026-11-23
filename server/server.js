// Silfab Procure local server: serves the site and runs the po_* database functions
// against the local PostgreSQL database. It replaces Supabase.
//
//   npm start            (reads server/.env)
//
// Every request runs in its own transaction as the limited "authenticated" role, with the
// user's email in request.jwt.claims, exactly as Supabase ran supabase/schema.sql.
// It listens on this PC only (127.0.0.1) and records every save as SILFAB_USER_EMAIL.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const envFile = path.join(here, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8490);
const USER_EMAIL = (process.env.SILFAB_USER_EMAIL || '').trim().toLowerCase();

// pg reads PGHOST, PGPORT, PGDATABASE, PGUSER and PGPASSWORD from the environment.
const pool = new pg.Pool({ max: 5 });
pool.on('error', (e) => console.error('database pool error:', e.message));

// The only functions the browser may call, with their argument names and SQL types, in order.
const FUNCTIONS = {
  po_whoami: [],
  po_timeline: [],
  po_verify_audit: [],
  po_list: [['p_as_of', 'timestamptz']],
  po_get: [['p_id', 'bigint'], ['p_as_of', 'timestamptz']],
  po_create: [['p', 'jsonb']],
  po_update: [['p_id', 'bigint'], ['p', 'jsonb']],
};

// The only files served. Nothing else in the folder (server/.env, local/, db/) is reachable.
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/config.js': ['config.js', 'text/javascript; charset=utf-8'],
};

const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw Object.assign(new Error('Request is too large'), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Request body is not valid JSON'), { status: 400 }); }
}

async function callFunction(fn, args) {
  const params = FUNCTIONS[fn];
  const values = params.map(([name, type]) => {
    const v = args[name] ?? null;
    return type === 'jsonb' && v !== null ? JSON.stringify(v) : v;
  });
  const placeholders = params.map(([, type], i) => `$${i + 1}::${type}`).join(', ');
  const claims = USER_EMAIL ? JSON.stringify({ email: USER_EMAIL, role: 'authenticated' }) : '';

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role authenticated');
    await client.query("select set_config('request.jwt.claims', $1, true)", [claims]);
    const r = await client.query(`select public.${fn}(${placeholders}) as v`, values);
    await client.query('commit');
    return r.rows[0].v;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const server = http.createServer(async (req, res) => {
  try {
    // Only this PC, by name (blocks DNS-rebinding tricks from other websites).
    if (!ALLOWED_HOSTS.has(req.headers.host || '')) return send(res, 421, { message: 'Unknown host' });
    const url = new URL(req.url, `http://${req.headers.host}`);

    const m = /^\/api\/rpc\/([a-z_]+)$/.exec(url.pathname);
    if (m) {
      if (req.method !== 'POST') return send(res, 405, { message: 'Use POST' });
      // Same-origin JSON only: another website open in the browser cannot call this API.
      const origin = req.headers.origin;
      if (origin && !ALLOWED_HOSTS.has(origin.replace(/^http:\/\//, ''))) return send(res, 403, { message: 'Cross-site requests are not allowed' });
      if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { message: 'Send JSON' });
      if (!Object.hasOwn(FUNCTIONS, m[1])) return send(res, 404, { message: 'Unknown function' });
      const args = await readJson(req);
      if (!args || typeof args !== 'object' || Array.isArray(args)) return send(res, 400, { message: 'Arguments must be an object' });
      return send(res, 200, { data: await callFunction(m[1], args) });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { message: 'Method not allowed' });
    const file = STATIC[url.pathname];
    if (!file) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    return send(res, 200, await readFile(path.join(root, file[0])), file[1]);
  } catch (e) {
    // Errors raised on purpose by procure.fail() carry the HTTP status in the SQLSTATE: PT400, PT409, ...
    const pt = /^PT(\d{3})$/.exec(e.code || '');
    if (pt) return send(res, Number(pt[1]), { message: e.message, code: e.code, details: e.detail || null });
    if (e.status) return send(res, e.status, { message: e.message });
    console.error(new Date().toISOString(), req.method, req.url, e);
    return send(res, 500, { message: 'The server could not complete that request. Check the server window for details.' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Silfab Procure running at http://localhost:${PORT}/`);
  console.log(USER_EMAIL ? `Saves are recorded as ${USER_EMAIL}` : 'Warning: SILFAB_USER_EMAIL is not set in server/.env, so the site will show "No access".');
});
