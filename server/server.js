// Silfab Procure server: serves the site and runs the po_* database functions against the
// local PostgreSQL database.
//
//   npm start            (reads server/.env)
//
// Every request runs in its own transaction as the limited "authenticated" role, with the
// user's email in request.jwt.claims, exactly as Supabase ran supabase/schema.sql.
//
// Who the user is:
//   - With AZURE_TENANT_ID and AZURE_CLIENT_ID set, every API call must carry a Microsoft
//     Entra ID access token for this app (from Teams SSO or a browser sign-in). The email in
//     the verified token is what the database checks against procure.app_user. The page on
//     SITE_ORIGIN (GitHub Pages) may then call the API through a Cloudflare quick tunnel.
//   - Without them, the server is for this PC only: it refuses the tunnel and records every
//     save as SILFAB_USER_EMAIL.
// It always listens on 127.0.0.1. The Cloudflare tunnel connects to it from this PC.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const envFile = path.join(here, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = (k) => (process.env[k] || '').trim();
const HOST = env('HOST') || '127.0.0.1';
const PORT = Number(env('PORT') || 8490);
// Where the public page lives. Teams SSO requires the app's Application ID URI to use this host.
const SITE_ORIGIN = (env('SITE_ORIGIN') || 'https://tootallted.github.io').replace(/\/+$/, '').toLowerCase();
const SITE_HOST = new URL(SITE_ORIGIN).host;
const TENANT_ID = env('AZURE_TENANT_ID');
const CLIENT_ID = env('AZURE_CLIENT_ID');
const SSO = !!(TENANT_ID && CLIENT_ID);
const LOCAL_USER_EMAIL = SSO ? '' : env('SILFAB_USER_EMAIL').toLowerCase();
const API_SCOPE = 'access_as_user';
const APP_ID_URI = CLIENT_ID ? `api://${SITE_HOST}/${CLIENT_ID}` : '';
// Cloudflare quick tunnels get a random https://<words>.trycloudflare.com address on each start.
const TUNNEL_HOST = /^[a-z0-9-]+\.trycloudflare\.com$/;

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

// The only files served. Nothing else in the folder (server/.env, local/, db/, the rest of
// node_modules) is reachable.
const JS = 'text/javascript; charset=utf-8';
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', JS],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/config.js': ['config.js', JS],
  '/vendor/msal-browser.min.js': ['vendor/msal-browser.min.js', JS],
  '/vendor/teams-js.min.js': ['vendor/teams-js.min.js', JS],
};

const LOCAL_HOSTS = [`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`];
const LOCAL_ORIGINS = new Set(LOCAL_HOSTS.map((h) => `http://${h}`));
// The tunnel is only answered once sign-in is on; without it, anyone could act as LOCAL_USER_EMAIL.
const hostAllowed = (host) => LOCAL_HOSTS.includes(host) || (SSO && TUNNEL_HOST.test(host));
const originAllowed = (origin) => LOCAL_ORIGINS.has(origin) || (SSO && origin === SITE_ORIGIN);

// The GitHub Pages page calls the API from another origin, so the API answers CORS for it.
// Tokens travel in the Authorization header (no cookies), so no credentials mode is needed.
function corsHeaders(origin) {
  return origin === SITE_ORIGIN && SSO
    ? { 'Access-Control-Allow-Origin': SITE_ORIGIN, Vary: 'Origin' }
    : {};
}

// The page may be shown inside Teams (and Outlook / Microsoft 365 app), and nowhere else.
const FRAME_ANCESTORS = "'self' https://teams.microsoft.com https://*.teams.microsoft.com https://teams.cloud.microsoft "
  + 'https://*.cloud.microsoft https://*.office.com https://*.microsoft365.com https://*.skype.com';

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    ...(res.cors || {}),
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `frame-ancestors ${FRAME_ANCESTORS}`,
    ...(SSO ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
  });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

// ---------- Microsoft Entra ID token check ----------
const jwks = SSO ? createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`)) : null;

async function emailFromToken(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  if (!m) throw httpError(401, 'Sign in to use this app');
  let claims;
  try {
    ({ payload: claims } = await jwtVerify(m[1], jwks, {
      // Teams SSO tokens are v1 (sts.windows.net); browser sign-in tokens may be v2.
      issuer: [`https://sts.windows.net/${TENANT_ID}/`, `https://login.microsoftonline.com/${TENANT_ID}/v2.0`],
      audience: [CLIENT_ID, APP_ID_URI].filter(Boolean),
      algorithms: ['RS256'],
      clockTolerance: 60,
    }));
  } catch (e) {
    throw httpError(401, `Your sign-in could not be verified (${e.code || e.message}). Sign in again.`);
  }
  if (claims.tid !== TENANT_ID) throw httpError(401, 'That account is from a different organization.');
  if (!String(claims.scp || '').split(' ').includes(API_SCOPE)) throw httpError(401, 'Your sign-in is missing permission for this app.');
  const email = String(claims.preferred_username || claims.upn || claims.email || '').trim().toLowerCase();
  if (!email.includes('@')) throw httpError(401, 'Your Microsoft account has no email address.');
  return email;
}

// ---------- requests ----------
async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw httpError(413, 'Request is too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw httpError(400, 'Request body is not valid JSON'); }
}

async function callFunction(fn, args, email) {
  const params = FUNCTIONS[fn];
  const values = params.map(([name, type]) => {
    const v = args[name] ?? null;
    return type === 'jsonb' && v !== null ? JSON.stringify(v) : v;
  });
  const placeholders = params.map(([, type], i) => `$${i + 1}::${type}`).join(', ');
  const claims = email ? JSON.stringify({ email, role: 'authenticated' }) : '';

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
    // Known host names only (blocks DNS-rebinding tricks from other websites).
    const host = (req.headers.host || '').toLowerCase();
    if (!hostAllowed(host)) return send(res, 421, { message: 'Unknown host' });
    const url = new URL(req.url, `http://${host}`);
    const origin = req.headers.origin;
    if (url.pathname.startsWith('/api/')) res.cors = corsHeaders(origin);

    // CORS preflight from the GitHub Pages page.
    if (req.method === 'OPTIONS') {
      if (!url.pathname.startsWith('/api/') || !res.cors['Access-Control-Allow-Origin']) return send(res, 403, { message: 'Cross-site requests are not allowed' });
      res.writeHead(204, {
        ...res.cors,
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '600',
      });
      return res.end();
    }

    // Public settings the page needs to start Microsoft sign-in. None of these are secrets.
    if (url.pathname === '/api/auth-config') {
      return send(res, 200, SSO
        ? { enabled: true, tenantId: TENANT_ID, clientId: CLIENT_ID, scope: `${APP_ID_URI}/${API_SCOPE}` }
        : { enabled: false });
    }

    const m = /^\/api\/rpc\/([a-z_]+)$/.exec(url.pathname);
    if (m) {
      if (req.method !== 'POST') return send(res, 405, { message: 'Use POST' });
      // Only this site's own pages may call the API; any other website open in the browser is refused.
      if (origin && !originAllowed(origin)) return send(res, 403, { message: 'Cross-site requests are not allowed' });
      if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { message: 'Send JSON' });
      if (!Object.hasOwn(FUNCTIONS, m[1])) return send(res, 404, { message: 'Unknown function' });
      const email = SSO ? await emailFromToken(req) : LOCAL_USER_EMAIL;
      const args = await readJson(req);
      if (!args || typeof args !== 'object' || Array.isArray(args)) return send(res, 400, { message: 'Arguments must be an object' });
      return send(res, 200, { data: await callFunction(m[1], args, email) });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { message: 'Method not allowed' });
    const file = STATIC[url.pathname];
    if (!file) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    return send(res, 200, await readFile(path.join(root, file[0])), file[1]);
  } catch (e) {
    // Errors raised on purpose by procure.fail() carry the HTTP status in the SQLSTATE: PT400, PT409, ...
    const pt = /^PT(\d{3})$/.exec(e.code || '');
    if (pt) return send(res, Number(pt[1]), { message: e.message, code: e.code, details: e.detail || null });
    if (e.status) return send(res, e.status, { message: e.message, code: e.status === 401 ? 'auth' : undefined });
    console.error(new Date().toISOString(), req.method, req.url, e);
    return send(res, 500, { message: 'The server could not complete that request. Check the server window for details.' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Silfab Procure running at http://localhost:${PORT}/`);
  if (SSO) {
    console.log(`Microsoft sign-in is on (tenant ${TENANT_ID}). Accepting API calls from ${SITE_ORIGIN} through a trycloudflare.com tunnel.`);
  } else {
    console.log(LOCAL_USER_EMAIL
      ? `This PC only. Saves are recorded as ${LOCAL_USER_EMAIL}.`
      : 'Warning: SILFAB_USER_EMAIL is not set in server/.env, so the site will show "No access".');
    console.log('The tunnel is refused until AZURE_TENANT_ID and AZURE_CLIENT_ID are set.');
  }
});
