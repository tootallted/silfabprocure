'use strict';
(() => {
  const MAX_LINES = 100;
  const LINE_FIELDS = ['description', 'due_date', 'quantity', 'unit_cost'];
  const FIELD_LABEL = {
    name: 'Name', effective_date: 'Effective date', description: 'Description',
    due_date: 'Due date', quantity: 'Qty', unit_cost: 'Unit cost', is_active: 'Status',
  };

  // ---------- helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const nf2 = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nfCost = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  const nfQty = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });
  const money = (n) => nf2.format(n || 0);
  const fmtDate = (s) => {
    if (!s) return '';
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  };
  const fmtTs = (t) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
  const fmtShort = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const toLocalInput = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const prefs = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  // ---------- backend: local Silfab Procure server ----------
  // Every read and write goes through the po_* database functions (supabase/schema.sql),
  // called through server/server.js. The tables themselves are not reachable from the browser.
  // On the PC that runs the server, talk to it directly; elsewhere (GitHub Pages, Teams) go
  // through the tunnel address in config.js.
  const onServerPc = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  let API_BASE = onServerPc ? '' : String((window.SILFAB_CONFIG || {}).apiUrl || '').replace(/\/+$/, '');

  // The tunnel's address changes whenever it restarts, and tools/start-tunnel.ps1 publishes the
  // current one in tunnel.json. Fetch it fresh on every load so a cached copy never points at a
  // tunnel that no longer exists.
  async function loadApiBase() {
    if (onServerPc) return;
    try {
      const r = await fetch(`tunnel.json?t=${Date.now()}`, { cache: 'no-store' });
      if (r.ok) {
        const { apiUrl } = await r.json();
        if (/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(apiUrl || '')) API_BASE = apiUrl;
      }
    } catch { /* keep the config.js value */ }
  }

  // Microsoft sign-in. Inside Teams, Teams hands over a token for this app (SSO, no prompt).
  // In a normal browser, MSAL signs in with a redirect to Microsoft and back.
  const auth = {
    ready: false,
    enabled: false,
    inTeams: false,
    cfg: null,
    msal: null,
    account: null,

    async init() {
      if (this.ready) return;
      await loadApiBase();
      let res;
      try { res = await fetch(`${API_BASE}/api/auth-config`); } catch { res = null; }
      if (!res || !res.ok) throw new Error('Could not reach the Silfab Procure server. Check that it is running.');
      this.cfg = await res.json();
      this.enabled = !!this.cfg.enabled;
      if (this.enabled) {
        this.inTeams = await this.startTeams();
        if (!this.inTeams) await this.startMsal();
      }
      this.ready = true;
    },

    async startTeams() {
      const framed = window.parent !== window || !!window.nativeInterface;
      if (!framed || !window.microsoftTeams) return false;
      try {
        await Promise.race([
          window.microsoftTeams.app.initialize(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ]);
        return true;
      } catch {
        return false;
      }
    },

    async startMsal() {
      if (!window.msal) throw new Error('The Microsoft sign-in library did not load.');
      this.msal = new window.msal.PublicClientApplication({
        auth: {
          clientId: this.cfg.clientId,
          authority: `https://login.microsoftonline.com/${this.cfg.tenantId}`,
          redirectUri: this.homeUrl(),
        },
        cache: { cacheLocation: 'localStorage' },
      });
      await this.msal.initialize();
      const r = await this.msal.handleRedirectPromise();
      this.account = r?.account || this.msal.getAllAccounts()[0] || null;
    },

    async token() {
      if (!this.enabled) return null;
      if (this.inTeams) {
        try {
          return await window.microsoftTeams.authentication.getAuthToken();
        } catch (e) {
          throw Object.assign(new Error(String(e?.message || e)), { status: 401 });
        }
      }
      if (!this.account) return null;
      try {
        const r = await this.msal.acquireTokenSilent({ scopes: [this.cfg.scope], account: this.account });
        return r.accessToken;
      } catch {
        return null; // the server answers 401 and the page offers to sign in again
      }
    },

    // The page's own folder, e.g. https://tootallted.github.io/silfabprocure/ or http://localhost:8490/.
    // Each must be registered as a single-page-application redirect URI in Entra ID.
    homeUrl() { return location.origin + location.pathname.replace(/[^/]*$/, ''); },
    canSignOut() { return this.enabled && !this.inTeams && !!this.account; },
    signIn() { return this.msal.loginRedirect({ scopes: [this.cfg.scope], prompt: 'select_account' }); },
    signOut() {
      if (this.msal) this.msal.logoutRedirect({ account: this.account, postLogoutRedirectUri: this.homeUrl() });
    },
  };

  async function rpc(fn, args = {}) {
    let res;
    try {
      const token = await auth.token();
      res = await fetch(`${API_BASE}/api/rpc/${fn}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(args),
      });
    } catch (e) {
      if (e.status === 401) { showGate('signin', e.message); throw e; }
      const err = new Error('Could not reach the Silfab Procure server. Check that it is running.');
      err.status = 0;
      throw err;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(body.message || `Request failed (${res.status})`);
      e.status = res.status;
      e.data = body.details ? { entered_at: body.details } : null;
      // body.code 'auth' = the server could not verify a Microsoft sign-in; otherwise it is the database's access check.
      if (e.status === 401) showGate(auth.enabled && body.code === 'auth' ? 'signin' : 'denied', e.message);
      if (e.status === 403) showGate('denied', e.message);
      throw e;
    }
    return body.data;
  }

  const backend = {
    timeline: () => rpc('po_timeline'),
    list: (asOf) => rpc('po_list', { p_as_of: asOf }),
    get: (id, asOf) => rpc('po_get', { p_id: id, p_as_of: asOf }),
    create: (body) => rpc('po_create', { p: body }),
    update: (id, body) => rpc('po_update', { p_id: id, p: body }),
    verify: () => rpc('po_verify_audit'),
    whoami: () => rpc('po_whoami'),
  };

  // ---------- state ----------
  const state = {
    timeline: [],
    asOf: null,            // null = latest (live, editable); otherwise epoch ms (read-only history)
    hideRevisions: prefs.get('po.hideRevisions', false),
    auditOpen: prefs.get('po.auditOpen', true),
    list: [],
    search: '',
    selectedId: null,
    mode: 'empty',         // 'empty' | 'view' | 'create'
    po: null,
    poError: null,
    draft: null,
    note: '',
    saving: false,
    saveError: null,
    loadSeq: 0,
  };
  const slider = { min: 0, max: 1 }; // seconds
  let keySeq = 0;
  let refreshTimer = null;

  const isHistory = () => state.asOf !== null;
  const asOfIso = () => (isHistory() ? new Date(state.asOf).toISOString() : null);

  // ---------- draft & change tracking ----------
  function newLine() {
    return { key: 'n' + (++keySeq), isNew: true, description: '', due_date: '', quantity: '1', unit_cost: '', removed: false, orig: null };
  }

  function resetDraft() {
    const po = state.po;
    state.saveError = null;
    state.note = '';
    if (!po) { state.draft = null; return; }
    state.draft = {
      name: po.header.name,
      effective_date: po.header.effective_date,
      orig: { name: po.header.name, effective_date: po.header.effective_date },
      lines: po.lines.map((l) => {
        const v = {
          description: l.description ?? '', due_date: l.due_date ?? '',
          quantity: String(l.quantity), unit_cost: String(l.unit_cost), removed: !l.is_active,
        };
        return { key: 'l' + l.id, id: l.id, base_version: l.version, line_number: l.line_number, src: l, ...v, orig: { ...v } };
      }),
    };
  }

  function sameVal(f, a, b) {
    if (f === 'quantity' || f === 'unit_cost') {
      const x = Number(a), y = Number(b);
      if (String(a).trim() !== '' && String(b).trim() !== '' && Number.isFinite(x) && Number.isFinite(y)) return x === y;
    }
    return String(a ?? '').trim() === String(b ?? '').trim();
  }

  function lineChangedFields(l) {
    if (l.isNew) return LINE_FIELDS;
    if (l.removed !== l.orig.removed) return ['removed'];
    if (l.removed) return [];
    return LINE_FIELDS.filter((f) => !sameVal(f, l[f], l.orig[f]));
  }

  const headerChanged = (d) => !sameVal('name', d.name, d.orig.name) || d.effective_date !== d.orig.effective_date;

  function pendingSummary() {
    const d = state.draft;
    if (!d || state.mode !== 'view') return [];
    const parts = [];
    if (headerChanged(d)) parts.push(`header → v${state.po.header.version + 1}`);
    let added = 0;
    for (const l of d.lines) {
      if (l.isNew) { added++; continue; }
      const ch = lineChangedFields(l);
      if (!ch.length) continue;
      const what = ch[0] === 'removed' ? (l.removed ? ' (remove)' : ' (restore)') : '';
      parts.push(`line ${l.line_number} → v${l.base_version + 1}${what}`);
    }
    if (added) parts.push(`${plural(added, 'new line')} at v1`);
    return parts;
  }

  function isDirty() {
    const d = state.draft;
    if (!d || isHistory()) return false;
    if (state.mode === 'create') {
      return !!(d.name.trim() || d.effective_date || d.lines.length > 1 ||
        d.lines.some((l) => l.description || l.due_date || l.unit_cost !== '' || l.quantity !== '1'));
    }
    return state.mode === 'view' && pendingSummary().length > 0;
  }

  function confirmDiscard() {
    if (!isDirty()) return true;
    return window.confirm('You have unsaved changes. Discard them?');
  }

  function lineTotal(l) {
    const q = String(l.quantity).trim(), c = String(l.unit_cost).trim();
    if (q === '' || c === '') return null;
    const qn = Number(q), cn = Number(c);
    if (!Number.isFinite(qn) || !Number.isFinite(cn)) return null;
    return Math.round((qn * cn + Number.EPSILON) * 100) / 100;
  }

  // ---------- data loading ----------
  async function loadTimeline() {
    state.timeline = await backend.timeline();
    computeSliderRange();
    renderTimebar();
  }

  async function refreshData() {
    const seq = ++state.loadSeq;
    const asOf = asOfIso();
    try {
      const wantDetail = state.selectedId && state.mode !== 'create';
      const [list, detail] = await Promise.all([
        backend.list(asOf),
        wantDetail
          ? backend.get(state.selectedId, asOf).then((po) => ({ po }), (error) => ({ error }))
          : null,
      ]);
      if (seq !== state.loadSeq) return; // a newer request superseded this one
      state.list = list;
      if (detail) {
        state.po = detail.po || null;
        state.poError = detail.error || null;
        state.mode = 'view';
        resetDraft();
      }
      renderList();
      if (state.mode !== 'create') renderDetail();
      renderTimebar();
    } catch (e) {
      toast(e.message, true);
    }
  }

  function scheduleRefresh(delay) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshData, delay);
  }

  async function verifyAudit() {
    const el = $('#auditStatus');
    try {
      const r = await backend.verify();
      el.className = 'audit-status ' + (r.ok ? 'ok' : 'bad');
      el.textContent = r.ok
        ? (r.count ? `✓ Audit chain verified · ${plural(r.count, 'save')}` : 'Audit chain empty')
        : `✗ Audit chain broken at save #${r.broken_at_changeset}`;
      el.title = r.ok
        ? 'Every save is sealed with a SHA-256 hash chained to the previous one. Any edit to stored history breaks the chain.'
        : 'Stored history no longer matches its seal — history has been altered outside the application.';
    } catch {
      el.textContent = '';
    }
  }

  // ---------- time travel ----------
  function computeSliderRange() {
    const nowS = Math.ceil(Date.now() / 1000);
    if (!state.timeline.length) { slider.min = nowS - 3600; slider.max = nowS; return; }
    const first = Math.floor(Date.parse(state.timeline[0].saved_at) / 1000);
    const span = Math.max(nowS - first, 60);
    slider.min = first - Math.max(5, Math.round(span * 0.03));
    slider.max = nowS;
  }

  function changeTimes() {
    const tl = state.selectedId && state.mode !== 'create'
      ? state.timeline.filter((c) => c.po_id === state.selectedId)
      : state.timeline;
    return [...new Set(tl.map((c) => Date.parse(c.saved_at)))].sort((a, b) => a - b);
  }

  function setAsOf(ms, delay = 150) {
    if (ms !== null && ms >= Date.now()) ms = null;
    if (ms === state.asOf) return;
    if (!confirmDiscard()) { renderTimebar(); return; }
    if (ms === null) computeSliderRange();
    state.asOf = ms;
    if (state.mode === 'create' && ms !== null) {
      state.mode = state.selectedId ? 'view' : 'empty';
      state.draft = null;
    }
    renderTimebar();
    renderList();
    scheduleRefresh(delay);
  }

  function renderTimebar() {
    const hist = isHistory();
    document.body.classList.toggle('history-mode', hist);
    const r = $('#tRange');
    r.min = slider.min;
    r.max = slider.max;
    r.value = hist ? Math.min(slider.max, Math.max(slider.min, Math.floor(state.asOf / 1000))) : slider.max;
    r.disabled = !state.timeline.length;
    $('#scaleMin').textContent = state.timeline.length ? fmtShort(slider.min * 1000) : '';

    const cur = hist ? state.asOf : Infinity;
    let currentId = null;
    for (const c of state.timeline) if (Date.parse(c.saved_at) <= cur) currentId = c.id;
    const span = slider.max - slider.min || 1;
    $('#ticks').innerHTML = state.timeline.map((c) => {
      const pct = Math.min(100, Math.max(0, ((Date.parse(c.saved_at) / 1000 - slider.min) / span) * 100));
      const cls = ['tick', c.po_id === state.selectedId ? 'mine' : '', hist && c.id === currentId ? 'current' : ''].join(' ');
      const title = `${c.po_number} · ${c.action === 'create' ? 'created' : 'updated'} ${fmtTs(c.saved_at)} by ${c.saved_by}${c.note ? ' — ' + c.note : ''}`;
      return `<button class="${cls}" style="left:${pct.toFixed(3)}%" data-t="${esc(c.saved_at)}" title="${esc(title)}" aria-label="${esc(title)}"></button>`;
    }).join('');

    $('#modePill').textContent = hist ? 'History' : 'Latest';
    $('#asOfText').textContent = hist
      ? `As of ${fmtTs(state.asOf)} · read-only`
      : state.timeline.length ? 'Showing current data · editable' : 'No saved purchase orders yet';
    if (document.activeElement !== $('#tInput')) $('#tInput').value = toLocalInput(hist ? state.asOf : Date.now());

    const times = changeTimes();
    const effective = times.filter((t) => t <= cur).pop();
    $('#tPrev').disabled = effective === undefined;
    $('#tNext').disabled = !hist;
    $('#tLatest').disabled = !hist;
    $('#newPo').disabled = hist;
  }

  function stepPrev() {
    const times = changeTimes();
    const cur = isHistory() ? state.asOf : Infinity;
    const effective = times.filter((t) => t <= cur).pop();
    if (effective === undefined) return;
    const prev = times.filter((t) => t < effective).pop();
    setAsOf(prev ?? effective - 1, 0); // before the first change: show "not yet entered"
  }

  function stepNext() {
    if (!isHistory()) return;
    const next = changeTimes().find((t) => t > state.asOf);
    setAsOf(next ?? null, 0);
  }

  // ---------- rendering: list ----------
  function renderList() {
    const term = state.search.trim().toLowerCase();
    const rows = state.list.filter((p) => !term || p.po_number.toLowerCase().includes(term) || p.name.toLowerCase().includes(term));
    const today = todayLocal();
    const el = $('#poList');
    if (!state.list.length) {
      el.innerHTML = `<div class="empty"><p>${isHistory() ? 'No purchase orders existed at this point in time.' : 'No purchase orders yet.'}</p></div>`;
    } else if (!rows.length) {
      el.innerHTML = '<div class="empty"><p>No purchase orders match your search.</p></div>';
    } else {
      el.innerHTML = `<table class="po-table">
        <thead><tr><th>Purchase order</th><th>Effective</th><th class="num">Total</th></tr></thead>
        <tbody>${rows.map((p) => `
          <tr data-id="${p.id}" tabindex="0" class="${p.id === state.selectedId && state.mode !== 'create' ? 'selected' : ''}">
            <td><div class="mono">${esc(p.po_number)} <span class="ver" title="Header version">v${p.version}</span></div>
              <div class="name" title="${esc(p.name)}">${esc(p.name)}</div>
              <div class="sub">${plural(p.line_count, 'line')}</div></td>
            <td class="eff">${fmtDate(p.effective_date)}${p.effective_date > today ? ' <span class="badge future">future</span>' : ''}</td>
            <td class="num">${money(p.total)}</td>
          </tr>`).join('')}</tbody></table>`;
    }
    const sum = rows.reduce((s, p) => s + p.total, 0);
    $('#listFoot').textContent = state.list.length
      ? `${plural(rows.length, 'purchase order')} · ${money(sum)} total${isHistory() ? ' · as of ' + fmtShort(state.asOf) : ''}`
      : '';
  }

  // ---------- rendering: detail ----------
  function renderDetail() {
    const el = $('#detail');
    if (state.mode === 'create') return renderEditor(el, null);
    if (!state.selectedId) {
      el.innerHTML = `<div class="detail-scroll"><div class="empty">
        <h2>${state.list.length ? 'Select a purchase order' : 'Create your first purchase order'}</h2>
        <p>${state.list.length ? 'Pick one from the list to view, edit or see its history.' : 'All you need is a name and a unit cost for one line.'}</p>
        ${isHistory() ? '' : '<button class="btn primary" data-act="new">+ New PO</button>'}
      </div></div>`;
      return;
    }
    if (state.poError) {
      const e = state.poError;
      el.innerHTML = `<div class="detail-scroll"><div class="empty">
        <h2>${e.status === 404 && e.data?.entered_at ? 'Not entered yet' : 'Unavailable'}</h2>
        <p class="${e.data?.entered_at ? 'not-yet' : ''}">${esc(e.message)}${e.data?.entered_at ? ` (entered ${esc(fmtTs(e.data.entered_at))}).` : ''}</p>
        ${e.data?.entered_at ? `<button class="btn" data-act="jump" data-t="${esc(e.data.entered_at)}">Jump to when it was entered</button>` : ''}
      </div></div>`;
      return;
    }
    if (!state.po || !state.draft) { el.innerHTML = '<div class="detail-scroll"><div class="empty"><p>Loading…</p></div></div>'; return; }
    renderEditor(el, state.po);
  }

  function renderEditor(el, po) {
    const creating = !po;
    const ro = !creating && isHistory();
    const d = state.draft;
    const future = d.effective_date && d.effective_date > todayLocal();

    el.innerHTML = `
      <div class="detail-scroll">
        <div class="detail-head">
          <div>
            <div class="eyebrow">${creating ? 'New purchase order' : 'Purchase order'}</div>
            <h2>${creating ? 'PO-<span class="ver">auto</span>' : esc(po.po_number)}${creating ? '' : `<span class="ver" title="Header version">v${po.header.version}</span>`}</h2>
            <div class="meta">${creating
              ? 'Only a name and each line’s unit cost are required. Number, entry date and versions are assigned on save.'
              : `Entered ${esc(fmtTs(po.entered_at))} · ${plural(po.audit.length, 'save')}${ro ? ' up to this point' : ''}`}</div>
          </div>
          <div class="total-box">
            <div class="label">PO total</div>
            <div class="amount" id="poTotalTop"></div>
            <div class="sub" id="lineCountTop"></div>
          </div>
        </div>
        ${ro ? `<div class="history-banner">Showing <b>${esc(po.po_number)}</b> exactly as it was recorded on <b>${esc(fmtTs(state.asOf))}</b>. Read-only — <button class="link" data-act="latest">return to latest</button> to edit.</div>` : ''}

        <section class="card">
          <div class="card-title">
            <h3>Header</h3>
            ${creating ? '' : `<span class="ver" title="Header version">v${po.header.version}</span><span class="sub">last changed ${esc(fmtTs(po.header.valid_from))} by ${esc(po.header.saved_by)}</span>`}
          </div>
          <div class="fields">
            <label class="field grow"><span>Name <i class="req">*</i></span>
              ${ro ? `<div class="static">${esc(d.name)}</div>` : `<input id="fName" data-h="name" maxlength="200" value="${esc(d.name)}" placeholder="e.g. Q1 office supplies" autocomplete="off">`}</label>
            <label class="field"><span>Effective date ${future ? '<span class="badge future">future</span>' : ''}</span>
              ${ro ? `<div class="static">${esc(fmtDate(d.effective_date))}</div>` : `<input type="date" id="fEff" data-h="effective_date" value="${esc(d.effective_date)}">`}
              <small>${creating ? 'Blank = entry date. May be backdated or future-dated.' : 'Overrides the entry date; may be past or future.'}</small></label>
            <div class="field"><span>Entered (actual)</span>
              <div class="static">${creating ? '<span class="ver">set on save</span>' : esc(fmtTs(po.entered_at))}</div>
              <small>System timestamp — cannot be changed.</small></div>
          </div>
          ${creating ? '' : headerRevisions(po)}
        </section>

        <section class="card">
          <div class="card-title"><h3>Lines</h3><span class="sub" id="lineCount"></span></div>
          <div class="table-wrap">
            <table class="lines">
              <colgroup><col class="c-ln"><col><col class="c-due"><col class="c-qty"><col class="c-cost"><col class="c-total"><col class="c-act"></colgroup>
              <thead><tr>
                <th>Line</th><th>Description</th><th>Due date</th><th class="num">Qty</th><th class="num">Unit cost</th><th class="num">Line total</th><th></th>
              </tr></thead>
              <tbody id="lineBody"></tbody>
              <tfoot><tr><td colspan="5" class="right">PO total</td><td class="num" id="poTotal"></td><td></td></tr></tfoot>
            </table>
          </div>
          ${ro ? '' : `<div class="add-row"><button class="btn ghost" data-act="add" id="addLine">+ Add line</button><span class="sub">Line total = qty × unit cost (calculated)</span></div>`}
        </section>

        ${creating ? '' : auditSection(po)}
      </div>
      ${ro ? '' : `
      <div class="savebar" id="savebar">
        <div class="pending" id="pending"></div>
        <input id="note" placeholder="Change note (optional, kept in audit trail)" maxlength="500" value="${esc(state.note)}" autocomplete="off">
        <button class="btn" data-act="discard" id="discardBtn">${creating ? 'Cancel' : 'Discard'}</button>
        <button class="btn primary" data-act="save" id="saveBtn" title="Ctrl+S">${creating ? 'Create purchase order' : 'Save changes'}</button>
      </div>`}`;
    renderLines();
    updateTotals();
    updateSavebar();
  }

  function headerRevisions(po) {
    if (state.hideRevisions || !po.header_history.length) return '';
    const versions = [po.header, ...po.header_history];
    const rows = po.header_history.map((h, i) => {
      const newer = versions[i];
      const cls = (f) => (h[f] !== newer[f] ? ' class="diff"' : '');
      return `<tr>
        <td><span class="ver">v${h.version}</span></td>
        <td><span${cls('name')}>${esc(h.name)}</span></td>
        <td>Eff. <span${cls('effective_date')}>${esc(fmtDate(h.effective_date))}</span></td>
        <td class="when" title="${esc(fmtTs(h.valid_from))}">${esc(fmtShort(h.valid_from))} · ${esc(h.saved_by)}</td>
      </tr>`;
    }).join('');
    return `<div class="revisions"><div class="rev-title">Prior header revisions</div><table class="rev-table">${rows}</table></div>`;
  }

  function renderLines() {
    const body = $('#lineBody');
    if (!body) return;
    const d = state.draft;
    const creating = state.mode === 'create';
    const ro = !creating && isHistory();
    const activeCount = d.lines.filter((l) => !l.removed).length;
    let nextNum = Math.max(0, ...d.lines.filter((l) => !l.isNew).map((l) => l.line_number)) + 1;
    const rows = [];

    for (const l of d.lines) {
      const num = l.isNew ? nextNum++ : l.line_number;
      const wasRemoved = !l.isNew && l.orig.removed;
      if (state.hideRevisions && wasRemoved && l.removed) continue; // removed lines are not current
      const pendingRemove = l.removed && !wasRemoved;
      const dis = ro || l.removed ? 'disabled' : '';
      const ver = l.isNew
        ? (creating ? '' : '<span class="ver">new</span>')
        : `<span class="ver" title="Line version">v${l.base_version}</span>`;
      let action = '';
      if (!ro) {
        action = l.removed
          ? `<button class="btn tiny" data-act="restore" data-key="${l.key}">${pendingRemove ? 'Undo' : 'Restore'}</button>`
          : `<button class="icon-btn" data-act="remove" data-key="${l.key}" title="Remove line" aria-label="Remove line ${num}" ${activeCount <= 1 ? 'disabled' : ''}>&times;</button>`;
      }
      if (ro && l.removed) action = '<span class="badge removed">removed</span>';
      const t = lineTotal(l);
      rows.push(`<tr class="line${l.isNew && !creating ? ' is-new' : ''}${l.removed ? ' is-removed' : ''}" data-key="${l.key}">
        <td class="ln" title="${l.removed ? (pendingRemove ? 'Will be removed on save' : 'Removed') : ''}"><span class="num-label">${num}</span> ${ver}</td>
        ${ro ? `
        <td class="ro-cell" title="${esc(l.description)}">${esc(l.description) || '<span class="ver">—</span>'}</td>
        <td class="ro-cell">${l.due_date ? esc(fmtDate(l.due_date)) : '<span class="ver">—</span>'}</td>
        <td class="num ro-cell">${esc(nfQty.format(Number(l.quantity)))}</td>
        <td class="num ro-cell">${esc(nfCost.format(Number(l.unit_cost)))}</td>` : `
        <td><input data-f="description" value="${esc(l.description)}" maxlength="500" placeholder="Optional" autocomplete="off" ${dis}></td>
        <td><input type="date" data-f="due_date" value="${esc(l.due_date)}" ${dis}></td>
        <td class="num"><input type="number" data-f="quantity" value="${esc(l.quantity)}" min="0" step="any" inputmode="decimal" ${dis}></td>
        <td class="num"><input type="number" data-f="unit_cost" value="${esc(l.unit_cost)}" min="0" step="0.01" inputmode="decimal" placeholder="0.00" ${dis}></td>`}
        <td class="num total" data-total>${t === null ? '—' : money(t)}</td>
        <td class="act">${action}</td>
      </tr>`);
      if (!state.hideRevisions && !l.isNew) rows.push(...lineRevisionRows(l.src));
    }
    body.innerHTML = rows.join('');
    const add = $('#addLine');
    if (add) {
      add.disabled = activeCount >= MAX_LINES;
      add.title = activeCount >= MAX_LINES ? `A purchase order can have at most ${MAX_LINES} lines` : '';
    }
    $('#lineCount').textContent = `${activeCount} of ${MAX_LINES} lines`;
    updateChangeMarks();
  }

  function lineRevisionRows(line) {
    const versions = [line, ...line.history];
    return line.history.map((h, i) => {
      const newer = versions[i];
      const c = (f) => (String(h[f] ?? '') !== String(newer[f] ?? '') ? ' diff' : '');
      return `<tr class="rev">
        <td class="ln"><span class="ver">v${h.version}</span></td>
        <td class="desc"><span class="${c('description')}">${esc(h.description || '—')}</span></td>
        <td><span class="${c('due_date')}">${h.due_date ? esc(fmtDate(h.due_date)) : '—'}</span></td>
        <td class="num"><span class="${c('quantity')}">${nfQty.format(h.quantity)}</span></td>
        <td class="num"><span class="${c('unit_cost')}">${nfCost.format(h.unit_cost)}</span></td>
        <td class="num"><span class="${c('line_total')}">${money(h.line_total)}</span></td>
        <td class="act" title="Saved ${esc(fmtTs(h.valid_from))} by ${esc(h.saved_by)}">${h.is_active ? '' : '<span class="badge muted">removed</span><br>'}${esc(fmtShort(h.valid_from))}</td>
      </tr>`;
    });
  }

  function auditSection(po) {
    return `<details class="card audit" id="auditDetails" ${state.auditOpen ? 'open' : ''}>
      <summary><h3>Audit trail</h3><span class="sub">${plural(po.audit.length, 'save')} · permanent, field-level history · click a time to view the PO as of then</span></summary>
      <ol class="audit-list">${po.audit.map(auditItem).join('')}</ol>
    </details>`;
  }

  function fmtVal(field, v) {
    if (v === null || v === undefined || v === '') return '<i>blank</i>';
    if (field === 'effective_date' || field === 'due_date') return esc(fmtDate(v));
    if (field === 'quantity') return esc(nfQty.format(Number(v)));
    if (field === 'unit_cost') return esc(nfCost.format(Number(v)));
    return `“${esc(v)}”`;
  }

  function auditItem(c) {
    const groups = new Map();
    for (const ch of c.changes) {
      const k = `${ch.entity}:${ch.entity_id}:${ch.version}`;
      if (!groups.has(k)) groups.set(k, { ...ch, items: [] });
      groups.get(k).items.push(ch);
    }
    const lines = [...groups.values()].map((g) => {
      const label = g.entity === 'header' ? 'Header' : `Line ${g.line_number}`;
      const ent = `<span class="ent">${label}</span> <span class="ver">v${g.version}</span>`;
      if (g.version === 1) {
        return `<li>${ent} ${g.entity === 'header' ? 'created' : 'added'}: ${g.items.map((i) => `${FIELD_LABEL[i.field]} ${fmtVal(i.field, i.new_value)}`).join(', ')}</li>`;
      }
      const act = g.items.find((i) => i.field === 'is_active');
      if (act) return `<li>${ent} ${act.new_value === '0' ? 'removed' : 'restored'}</li>`;
      return `<li>${ent}: ${g.items.map((i) => `${FIELD_LABEL[i.field]} <s>${fmtVal(i.field, i.old_value)}</s> → ${fmtVal(i.field, i.new_value)}`).join('; ')}</li>`;
    }).join('');
    return `<li class="${c.action}">
      <div class="audit-head">
        <button class="link" data-act="jump" data-t="${esc(c.saved_at)}" title="View this PO as of this save">${esc(fmtTs(c.saved_at))}</button>
        <span class="tag ${c.action}">${c.action === 'create' ? 'Created' : 'Updated'}</span>
        <span class="who">by ${esc(c.saved_by)}</span>
        <span class="ver">save #${c.id}</span>
      </div>
      ${c.note ? `<div class="audit-note">${esc(c.note)}</div>` : ''}
      <ul class="changes">${lines}</ul>
    </li>`;
  }

  function updateTotals() {
    const d = state.draft;
    if (!d) return;
    const active = d.lines.filter((l) => !l.removed);
    const sum = active.reduce((s, l) => s + (lineTotal(l) ?? 0), 0);
    const total = Math.round((sum + Number.EPSILON) * 100) / 100;
    $('#poTotal').textContent = money(total);
    $('#poTotalTop').textContent = money(total);
    $('#lineCountTop').textContent = plural(active.length, 'line');
  }

  function updateChangeMarks() {
    const d = state.draft;
    if (!d || state.mode !== 'view' || isHistory()) return;
    $('#fName')?.classList.toggle('changed', !sameVal('name', d.name, d.orig.name));
    $('#fEff')?.classList.toggle('changed', d.effective_date !== d.orig.effective_date);
    for (const l of d.lines) {
      const row = document.querySelector(`tr[data-key="${l.key}"]`);
      if (!row || l.isNew) continue;
      const changed = l.removed ? [] : lineChangedFields(l);
      for (const f of LINE_FIELDS) row.querySelector(`[data-f="${f}"]`)?.classList.toggle('changed', changed.includes(f));
    }
  }

  function updateSavebar() {
    const bar = $('#savebar');
    if (!bar) return;
    const creating = state.mode === 'create';
    const parts = pendingSummary();
    const dirty = creating || parts.length > 0;
    bar.classList.toggle('dirty', !creating && dirty);
    $('#saveBtn').disabled = state.saving || !dirty;
    $('#discardBtn').disabled = state.saving || (!creating && !dirty);
    $('#saveBtn').textContent = state.saving ? 'Saving…' : creating ? 'Create purchase order' : 'Save changes';
    let html;
    if (state.saveError) {
      html = `<span class="err">${esc(state.saveError.message)}</span>${state.saveError.status === 409 ? ' <button class="link" data-act="reload">Reload latest</button>' : ''}`;
    } else if (creating) {
      html = 'Saves as header <span class="ver">v1</span> with each line at <span class="ver">v1</span>.';
    } else if (parts.length) {
      const shown = parts.slice(0, 5).join(', ') + (parts.length > 5 ? `, +${parts.length - 5} more` : '');
      html = `<b>Unsaved:</b> ${esc(shown)} <span class="kbd">· Ctrl+S</span>`;
    } else {
      html = 'No unsaved changes. Edit any field, then Save to record a new version.';
    }
    $('#pending').innerHTML = html;
  }

  function markInvalid(el) {
    if (!el) return;
    el.classList.add('invalid');
    el.focus();
  }

  function validateDraft() {
    document.querySelectorAll('.invalid').forEach((e) => e.classList.remove('invalid'));
    const d = state.draft;
    if (!d.name.trim()) { markInvalid($('#fName')); return 'Name is required.'; }
    if (state.mode === 'view' && !d.effective_date) { markInvalid($('#fEff')); return 'Effective date is required.'; }
    const active = d.lines.filter((l) => !l.removed);
    if (!active.length) return 'A purchase order needs at least one line.';
    if (active.length > MAX_LINES) return `A purchase order can have at most ${MAX_LINES} lines.`;
    let nextNum = Math.max(0, ...d.lines.filter((l) => !l.isNew).map((l) => l.line_number)) + 1;
    for (const l of d.lines) {
      const num = l.isNew ? nextNum++ : l.line_number;
      if (l.removed) continue;
      const row = document.querySelector(`tr[data-key="${l.key}"]`);
      const q = String(l.quantity).trim(), c = String(l.unit_cost).trim();
      if (q === '' || !(Number(q) > 0)) { markInvalid(row?.querySelector('[data-f="quantity"]')); return `Line ${num}: quantity must be greater than 0.`; }
      if (c === '' || !Number.isFinite(Number(c)) || Number(c) < 0) { markInvalid(row?.querySelector('[data-f="unit_cost"]')); return `Line ${num}: unit cost is required.`; }
    }
    return null;
  }

  async function save() {
    if (state.saving || isHistory() || !state.draft) return;
    const creating = state.mode === 'create';
    if (!creating && !pendingSummary().length) return;
    const msg = validateDraft();
    if (msg) { state.saveError = { message: msg }; updateSavebar(); return; }
    const d = state.draft;
    const linePayload = (l) => ({
      description: l.description, due_date: l.due_date || null, quantity: String(l.quantity).trim(), unit_cost: String(l.unit_cost).trim(),
    });
    state.saving = true;
    state.saveError = null;
    updateSavebar();
    try {
      if (creating) {
        const r = await backend.create({
          name: d.name, effective_date: d.effective_date || todayLocal(), note: state.note,
          lines: d.lines.filter((l) => !l.removed).map(linePayload),
        });
        state.selectedId = r.id;
        state.mode = 'view';
        state.po = null;
        history.replaceState(null, '', `#po=${r.id}`);
        toast(`${r.po_number} created`);
      } else {
        const r = await backend.update(state.po.id, {
          base_version: state.po.header.version,
          name: d.name,
          effective_date: d.effective_date,
          note: state.note,
          lines: d.lines
            .filter((l) => !(l.isNew && l.removed))
            .map((l) => (l.isNew ? linePayload(l) : { id: l.id, base_version: l.base_version, ...linePayload(l), removed: l.removed })),
        });
        const bits = [];
        if (r.header_changed) bits.push(`header v${r.header_version}`);
        if (r.lines_changed) bits.push(plural(r.lines_changed, 'line') + ' versioned');
        if (r.lines_added) bits.push(plural(r.lines_added, 'line') + ' added');
        toast(r.changed ? `Saved ${r.po_number}: ${bits.join(', ')}` : 'Nothing changed');
      }
      state.saving = false;
      await loadTimeline();
      await refreshData();
      verifyAudit();
    } catch (e) {
      state.saveError = e;
      toast(e.message, true);
    } finally {
      state.saving = false;
      updateSavebar();
    }
  }

  function discard() {
    if (state.mode === 'create') {
      if (!confirmDiscard()) return;
      state.mode = state.selectedId ? 'view' : 'empty';
      state.draft = null;
      if (state.mode === 'view') resetDraft();
      renderList();
      renderDetail();
      if (state.mode === 'view') refreshData();
      return;
    }
    resetDraft();
    renderDetail();
  }

  function startCreate() {
    if (isHistory() || !confirmDiscard()) return;
    state.mode = 'create';
    state.saveError = null;
    state.note = '';
    state.draft = { name: '', effective_date: '', orig: { name: '', effective_date: '' }, lines: [newLine()] };
    renderList();
    renderDetail();
    renderTimebar();
    $('#fName')?.focus();
  }

  function selectPO(id) {
    if (id === state.selectedId && state.mode === 'view') return;
    if (!confirmDiscard()) return;
    state.selectedId = id;
    state.mode = 'view';
    state.po = null;
    state.draft = null;
    state.poError = null;
    history.replaceState(null, '', `#po=${id}`);
    renderList();
    renderDetail();
    renderTimebar();
    refreshData();
  }

  let toastTimer;
  function toast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' error' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 3000);
  }

  // ---------- events ----------
  function onDetailInput(e) {
    const t = e.target;
    const d = state.draft;
    if (!d) return;
    if (t.id === 'note') { state.note = t.value; return; }
    t.classList.remove('invalid');
    state.saveError = null;
    if (t.dataset.h) {
      d[t.dataset.h] = t.value;
    } else if (t.dataset.f) {
      const row = t.closest('tr[data-key]');
      const l = d.lines.find((x) => x.key === row?.dataset.key);
      if (!l) return;
      l[t.dataset.f] = t.value;
      if (t.dataset.f === 'quantity' || t.dataset.f === 'unit_cost') {
        const tot = lineTotal(l);
        row.querySelector('[data-total]').textContent = tot === null ? '—' : money(tot);
        updateTotals();
      }
    } else return;
    updateChangeMarks();
    updateSavebar();
  }

  function onDetailClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const d = state.draft;
    const line = () => d.lines.find((l) => l.key === b.dataset.key);
    switch (b.dataset.act) {
      case 'add': {
        if (d.lines.filter((l) => !l.removed).length >= MAX_LINES) return;
        const nl = newLine();
        d.lines.push(nl);
        renderLines(); updateTotals(); updateSavebar();
        document.querySelector(`tr[data-key="${nl.key}"] [data-f="description"]`)?.focus();
        break;
      }
      case 'remove': {
        const l = line();
        if (!l || d.lines.filter((x) => !x.removed).length <= 1) return;
        if (l.isNew) d.lines.splice(d.lines.indexOf(l), 1);
        else l.removed = true;
        state.saveError = null;
        renderLines(); updateTotals(); updateSavebar();
        break;
      }
      case 'restore': {
        const l = line();
        if (!l || d.lines.filter((x) => !x.removed).length >= MAX_LINES) return;
        l.removed = false;
        renderLines(); updateTotals(); updateSavebar();
        break;
      }
      case 'save': save(); break;
      case 'discard': discard(); break;
      case 'new': startCreate(); break;
      case 'latest': setAsOf(null, 0); break;
      case 'jump': setAsOf(Date.parse(b.dataset.t), 0); break;
      case 'reload':
        state.saveError = null;
        Promise.all([loadTimeline(), refreshData()]).then(verifyAudit);
        break;
    }
  }

  function init() {
    const hide = $('#hideRevisions');
    hide.checked = state.hideRevisions;
    hide.addEventListener('change', () => {
      state.hideRevisions = hide.checked;
      prefs.set('po.hideRevisions', state.hideRevisions);
      if (state.draft) renderDetail();
    });

    $('#search').addEventListener('input', (e) => { state.search = e.target.value; renderList(); });
    $('#newPo').addEventListener('click', startCreate);
    $('#poList').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (tr) selectPO(Number(tr.dataset.id));
    });
    $('#poList').addEventListener('keydown', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectPO(Number(tr.dataset.id)); }
    });

    const detail = $('#detail');
    detail.addEventListener('input', onDetailInput);
    detail.addEventListener('change', onDetailInput);
    detail.addEventListener('click', onDetailClick);
    detail.addEventListener('toggle', (e) => {
      if (e.target.id === 'auditDetails') { state.auditOpen = e.target.open; prefs.set('po.auditOpen', state.auditOpen); }
    }, true);

    const range = $('#tRange');
    range.addEventListener('input', () => {
      const v = Number(range.value);
      setAsOf(v >= slider.max ? null : v * 1000 + 999);
    });
    $('#ticks').addEventListener('click', (e) => {
      const t = e.target.closest('.tick');
      if (t) setAsOf(Date.parse(t.dataset.t), 0);
    });
    $('#tPrev').addEventListener('click', stepPrev);
    $('#tNext').addEventListener('click', stepNext);
    $('#tLatest').addEventListener('click', () => setAsOf(null, 0));
    $('#tInput').addEventListener('change', (e) => {
      if (!e.target.value) return;
      const ms = new Date(e.target.value).getTime();
      if (Number.isFinite(ms)) setAsOf(ms + 999, 0);
    });

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        if ($('#savebar')) { e.preventDefault(); save(); }
      }
    });
    window.addEventListener('beforeunload', (e) => {
      if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
    });

    const m = location.hash.match(/po=(\d+)/);
    if (m) { state.selectedId = Number(m[1]); state.mode = 'view'; }

    initAuth();
  }

  // ---------- access check ----------
  // With Microsoft sign-in on, the server reads your email from a verified Microsoft token;
  // without it, the server uses SILFAB_USER_EMAIL. Either way the database checks that email
  // against procure.app_user.
  let booted = false;

  function showGate(kind, message = '') {
    const gate = $('#gate');
    document.body.classList.add('gated');
    gate.hidden = false;
    const views = {
      loading: '<p class="gate-msg">Loading…</p>',
      offline: `<h2>Can't reach the server</h2>
        <p class="gate-msg">${esc(message || 'The Silfab Procure server is not responding.')}</p>
        <button class="btn primary" data-gate="retry">Try again</button>`,
      denied: `<h2>No access</h2>
        <p class="gate-msg">${esc(message || 'Your account is not authorized for this app.')}</p>
        <button class="btn" data-gate="retry">Try again</button>
        ${auth.canSignOut() ? '<button class="link" data-gate="logout">Sign in as someone else</button>' : ''}`,
      signin: auth.inTeams
        ? `<h2>Couldn't sign you in</h2>
          <p class="gate-msg">Teams could not get a sign-in for Silfab Procure${message ? ` (${esc(message)})` : ''}. Ask an administrator to check the app's Microsoft Entra ID setup.</p>
          <button class="btn primary" data-gate="retry">Try again</button>`
        : `<h2>Sign in</h2>
          <p class="gate-msg">Use your work Microsoft account.</p>
          <button class="btn primary" data-gate="login">Sign in with Microsoft</button>
          ${message ? `<p class="gate-err" role="alert">${esc(message)}</p>` : ''}`,
    };
    gate.querySelector('.gate-card').innerHTML = `<div class="gate-brand"><span class="logo">SP</span><span>Silfab Procure</span></div>
      ${views[kind] || ''}`;
  }

  function hideGate() {
    $('#gate').hidden = true;
    document.body.classList.remove('gated');
  }

  function renderUser(email) {
    $('#userBox').innerHTML = email
      ? `<span class="user-email" title="Saves are recorded as this person">${esc(email)}</span>${auth.canSignOut() ? '<button class="btn tiny" id="signOut">Sign out</button>' : ''}`
      : '';
  }

  async function checkAccess() {
    showGate('loading');
    try {
      await auth.init();
    } catch (e) {
      // MSAL errors (from the Microsoft sign-in redirect) carry an errorCode; anything else means the server is down.
      showGate(e.errorCode ? 'signin' : 'offline', e.message);
      return;
    }
    if (auth.enabled && !auth.inTeams && !auth.account) { showGate('signin'); return; }
    let who;
    try {
      who = await backend.whoami();
    } catch (e) {
      if (e.status !== 401 && e.status !== 403) showGate('offline', e.message);
      return; // rpc() has already shown the sign-in or no-access screen
    }
    renderUser(who.email);
    if (!who.allowed) {
      showGate('denied', who.email
        ? `${who.email} is not on the access list for Silfab Procure. Ask an administrator to add you.`
        : 'This server has no user set. Put your email in SILFAB_USER_EMAIL in server/.env and restart the server.');
      return;
    }
    hideGate();
    if (booted) return;
    booted = true;
    renderDetail();
    try {
      await loadTimeline();
      await refreshData();
      verifyAudit();
    } catch (e) {
      toast(e.message, true);
    }
  }

  function initAuth() {
    $('#gate').addEventListener('click', (e) => {
      const b = e.target.closest('[data-gate]');
      if (!b) return;
      if (b.dataset.gate === 'retry') checkAccess();
      if (b.dataset.gate === 'login') auth.signIn().catch((err) => showGate('signin', err.message));
      if (b.dataset.gate === 'logout') auth.signOut();
    });
    $('#userBox').addEventListener('click', (e) => {
      if (e.target.id === 'signOut' && confirmDiscard()) auth.signOut();
    });
    checkAccess();
  }

  init();
})();
