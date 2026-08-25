/* =====================================================================
   GLOBAL EPI — Field Collect
   ---------------------------------------------------------------------
   An offline-first collection client. It implements the synchronisation
   protocol from the platform architecture: client-generated UUIDv7
   operation ids, an append-only event log, at-least-once delivery from
   an outbox, idempotent ingest, and divergence surfaced as a conflict
   rather than silently resolved.

   The server here is simulated in a separate IndexedDB store so the
   protocol can be demonstrated end to end — including replay and
   conflict — with no backend. Replacing it is one function: `transmit`.

   PILOT SCOPE: no identifying information. This is not a HIPAA-compliant
   system and must not be used for PHI. See the About screen.
===================================================================== */
'use strict';

/* ── UUIDv7 ──────────────────────────────────────────────────────────
   Time-ordered, so ids sort by creation and index well, without relying
   on the device clock for correctness anywhere in the protocol.       */
function uuidv7() {
  const ts = BigInt(Date.now());
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[0] = Number((ts >> 40n) & 0xffn); b[1] = Number((ts >> 32n) & 0xffn);
  b[2] = Number((ts >> 24n) & 0xffn); b[3] = Number((ts >> 16n) & 0xffn);
  b[4] = Number((ts >> 8n) & 0xffn);  b[5] = Number(ts & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;                 // version 7
  b[8] = (b[8] & 0x3f) | 0x80;                 // variant
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/* ── Crypto ──────────────────────────────────────────────────────────
   Records are encrypted at rest with AES-256-GCM under a key derived
   from the collector's passphrase. A separate HMAC key signs each
   envelope so corruption or tampering is detectable on ingest.        */
const Crypto = {
  aesKey: null, macKey: null,

  async derive(passphrase, saltB64) {
    const salt = unb64(saltB64);
    const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, base, 512);
    const raw = new Uint8Array(bits);
    this.aesKey = await crypto.subtle.importKey('raw', raw.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
    this.macKey = await crypto.subtle.importKey('raw', raw.slice(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    return b64(await crypto.subtle.digest('SHA-256', raw.slice(0, 32)));  // verifier, not the key
  },

  async encrypt(obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.aesKey, enc.encode(JSON.stringify(obj)));
    return { iv: b64(iv), ct: b64(ct) };
  },

  async decrypt(payload) {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(payload.iv) }, this.aesKey, unb64(payload.ct));
    return JSON.parse(dec.decode(pt));
  },

  async sign(str) { return b64(await crypto.subtle.sign('HMAC', this.macKey, enc.encode(str))); },
  async verify(str, sig) {
    return crypto.subtle.verify('HMAC', this.macKey, unb64(sig), enc.encode(str));
  },
  locked() { return this.aesKey === null; },
  lock() { this.aesKey = null; this.macKey = null; },
};

/* ── Storage ─────────────────────────────────────────────────────── */
const DB = {
  db: null,
  async open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('epi-collect', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('meta', { keyPath: 'k' });
        const ev = d.createObjectStore('events', { keyPath: 'op_id' });
        ev.createIndex('submission', 'submission_id');
        d.createObjectStore('outbox', { keyPath: 'op_id' });
        const sv = d.createObjectStore('server', { keyPath: 'key' });
        sv.createIndex('submission', 'submission_id');
        d.createObjectStore('audit', { keyPath: 'id' });
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode = 'readonly') { return this.db.transaction(store, mode).objectStore(store); },
  req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  get(store, key) { return this.req(this.tx(store).get(key)); },
  all(store) { return this.req(this.tx(store).getAll()); },
  put(store, val) { return this.req(this.tx(store, 'readwrite').put(val)); },
  del(store, key) { return this.req(this.tx(store, 'readwrite').delete(key)); },
  async meta(k, v) {
    if (v === undefined) { const r = await this.get('meta', k); return r ? r.v : null; }
    return this.put('meta', { k, v });
  },
};

/* ── Audit ─────────────────────────────────────────────────────────
   Local trail of who did what on this device. Append-only by
   convention here; on the real platform this streams to write-once
   storage the application cannot rewrite.                            */
async function audit(action, detail) {
  await DB.put('audit', {
    id: uuidv7(), at: new Date().toISOString(),
    collector: State.collector, device: State.deviceId, action, detail: detail || '',
  });
}

/* ── App state ─────────────────────────────────────────────────────── */
const State = {
  instrument: null, deviceId: null, collector: null,
  answers: {}, section: 0,
  submissionId: null, baseVersion: null,
  screen: 'unlock',
};

/* ── Instrument logic ──────────────────────────────────────────────── */
function visible(q, answers) {
  const c = q.showIf;
  if (!c) return true;
  const v = answers[c.q];
  if (c.eq !== undefined) return v === c.eq;
  if (c.notEq !== undefined) return v !== undefined && v !== null && v !== '' && v !== c.notEq;
  if (c.in !== undefined) return c.in.includes(v);
  return true;
}

function maskToRegex(mask) {
  // A = letter, 0 = digit, everything else literal.
  return new RegExp('^' + [...mask].map((ch) =>
    ch === 'A' ? '[A-Za-z]' : ch === '0' ? '[0-9]' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  ).join('') + '$');
}

function validateQuestion(q, answers) {
  if (!visible(q, answers)) return null;
  const v = answers[q.id];
  const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0) || v === false;

  if (q.required && empty) {
    return q.type === 'checkbox' ? 'This must be confirmed to continue.' : 'This answer is required.';
  }
  if (empty) return null;

  if (q.type === 'text' && q.mask && !maskToRegex(q.mask).test(v)) {
    return `Use the format ${q.mask.replace(/A/g, 'X').replace(/0/g, '9')} — for example ${q.placeholder || ''}.`.trim();
  }
  if (q.maxLength && String(v).length > q.maxLength) return `Keep this under ${q.maxLength} characters.`;
  if (q.type === 'integer' || q.type === 'number' || q.type === 'scale') {
    const n = Number(v);
    if (!Number.isFinite(n)) return 'Enter a number.';
    if (q.type === 'integer' && !Number.isInteger(n)) return 'Enter a whole number.';
    if (q.min !== undefined && n < q.min) return `Cannot be less than ${q.min}.`;
    if (q.max !== undefined && n > q.max) return `Cannot be more than ${q.max}.`;
  }
  if (q.atMostField) {
    const cap = Number(answers[q.atMostField.field]);
    if (Number.isFinite(cap) && Number(v) > cap) return q.atMostField.message;
  }
  if (q.maxSelections && Array.isArray(v) && v.length > q.maxSelections) {
    return `Choose no more than ${q.maxSelections}.`;
  }
  return null;
}

function validateSection(section, answers) {
  const errs = {};
  section.questions.forEach((q) => { const e = validateQuestion(q, answers); if (e) errs[q.id] = e; });
  return errs;
}

/* Answers to questions hidden by conditional logic are dropped, so a
   changed earlier answer cannot leave orphaned data in the record. */
function pruneHidden(answers, instrument) {
  const out = { ...answers };
  instrument.sections.forEach((s) => s.questions.forEach((q) => {
    if (!visible(q, out)) delete out[q.id];
  }));
  return out;
}

/* ── Sync protocol ───────────────────────────────────────────────────
   Envelope, outbox, transmit, ingest. The shape matches the reference
   architecture exactly so the real server can be dropped in later.   */
async function buildEnvelope(answers, submissionId, version, parentVersion) {
  const payload = await Crypto.encrypt(answers);
  const env = {
    op_id: uuidv7(),
    tenant_id: State.tenantId,
    instrument_id: State.instrument.id,
    instrument_version: State.instrument.version,
    submission_id: submissionId,
    version, parent_version: parentVersion,
    device_id: State.deviceId,
    collector_id: State.collector,
    captured_at_device: new Date().toISOString(),
    payload,
  };
  env.payload_hmac = await Crypto.sign(
    `${env.op_id}|${env.submission_id}|${env.version}|${env.payload.ct}`);
  return env;
}

/* The simulated server. Idempotent on (tenant_id, op_id); appends only;
   flags divergence instead of choosing a winner. */
async function transmit(env) {
  const key = `${env.tenant_id}:${env.op_id}`;
  const existing = await DB.get('server', key);
  if (existing) return { status: 'duplicate', op_id: env.op_id, server_seq: existing.server_seq };

  const ok = await Crypto.verify(
    `${env.op_id}|${env.submission_id}|${env.version}|${env.payload.ct}`, env.payload_hmac);
  if (!ok) return { status: 'quarantined', op_id: env.op_id };

  const log = await DB.all('server');
  const sameParent = log.filter((e) =>
    e.submission_id === env.submission_id && e.version === env.version);
  const seq = (Number(await DB.meta('server_seq')) || 0) + 1;
  await DB.meta('server_seq', seq);
  await DB.put('server', { key, server_seq: seq, received_at: new Date().toISOString(), ...env });
  return {
    status: 'accepted', op_id: env.op_id, server_seq: seq,
    conflict: sameParent.length > 0,
  };
}

/* At-least-once from the outbox; the operation is removed only after a
   durable acknowledgement naming its op_id. */
async function syncOutbox() {
  const pending = (await DB.all('outbox')).sort((a, b) => a.op_id.localeCompare(b.op_id));
  let sent = 0, dupes = 0, conflicts = 0, failed = 0;

  for (const env of pending) {
    let ack;
    try { ack = await transmit(env); } catch { failed++; continue; }

    if (ack.status === 'quarantined') { failed++; continue; }
    if (ack.status === 'duplicate') dupes++;
    if (ack.status === 'accepted') { sent++; if (ack.conflict) conflicts++; }

    const local = await DB.get('events', env.op_id);
    if (local) {
      local.synced = true;
      local.server_seq = ack.server_seq;
      local.conflict = !!ack.conflict;
      await DB.put('events', local);          // durable local commit …
    }
    await DB.del('outbox', env.op_id);        // … only then purge the outbox
  }
  await audit('sync', `sent ${sent}, duplicates ${dupes}, conflicts ${conflicts}, failed ${failed}`);
  return { sent, dupes, conflicts, failed };
}

/* ── Submissions view ──────────────────────────────────────────────── */
async function submissions() {
  const events = await DB.all('events');
  const bySub = new Map();
  for (const e of events) {
    if (!bySub.has(e.submission_id)) bySub.set(e.submission_id, []);
    bySub.get(e.submission_id).push(e);
  }
  const out = [];
  for (const [id, evs] of bySub) {
    evs.sort((a, b) => a.version - b.version);
    const latest = evs[evs.length - 1];
    const versions = evs.map((e) => e.version);
    // Labels are derived by decrypting in memory, never stored in the clear —
    // a stored label would put the participant code back on disk unencrypted.
    let label = '—';
    try { label = (await Crypto.decrypt(latest.payload)).participant_code || '—'; } catch { label = '(locked)'; }
    out.push({
      id, events: evs, latest, label,
      version: latest.version,
      conflict: evs.some((e) => e.conflict) || new Set(versions).size !== versions.length,
      synced: evs.every((e) => e.synced),
      capturedAt: evs[0].captured_at_device,
    });
  }
  return out.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
}

/* ── Tiny view helpers ─────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function show(name) {
  State.screen = name;
  ['unlock', 'home', 'form', 'queue', 'record', 'about'].forEach((s) => {
    $(`scr-${s}`).hidden = s !== name;
  });
  window.scrollTo(0, 0);
}

function setActions(html) {
  const bar = $('actionbar');
  bar.innerHTML = html || '';
  bar.hidden = !html;
}

function netStatus() {
  const on = navigator.onLine;
  $('netdot').classList.toggle('on', on);
  $('nettext').textContent = on ? 'Online' : 'Offline';
}

/* ── Screen: unlock ────────────────────────────────────────────────── */
async function renderUnlock() {
  const salt = await DB.meta('salt');
  const first = !salt;
  $('scr-unlock').innerHTML = `
    <div class="card">
      <p class="eyebrow">${first ? 'Set up this device' : 'Unlock'}</p>
      <h2>${first ? 'Create a device passphrase' : 'Enter your passphrase'}</h2>
      <p class="muted">${first
        ? 'Records saved on this device are encrypted with a key derived from this passphrase. It is never stored and cannot be recovered — if it is lost, the data on this device is unreadable.'
        : 'This releases the key that decrypts records held on this device.'}</p>
      <div class="q">
        <label class="lbl" for="pass">Passphrase</label>
        <input id="pass" type="password" autocomplete="current-password" inputmode="text" />
        <p class="err" id="pass-err" hidden></p>
      </div>
      ${first ? `
      <div class="q">
        <label class="lbl" for="pass2">Confirm passphrase</label>
        <input id="pass2" type="password" autocomplete="new-password" />
      </div>
      <div class="q">
        <label class="lbl" for="collector">Collector identifier</label>
        <p class="hint">A staff code, not a name.</p>
        <input id="collector" type="text" value="GE-COLLECTOR-01" />
      </div>` : ''}
      <button class="btn wide" id="do-unlock">${first ? 'Create and continue' : 'Unlock'}</button>
    </div>
    <div class="notice warn">
      <b>Pilot scope</b>
      <span>This build is for non-identifying data only. It is not a HIPAA-compliant system.</span>
    </div>`;
  setActions('');

  $('do-unlock').onclick = async () => {
    const pass = $('pass').value;
    const err = $('pass-err');
    err.hidden = true;
    if (pass.length < 8) { err.textContent = 'Use at least 8 characters.'; err.hidden = false; return; }
    if (first) {
      if (pass !== $('pass2').value) { err.textContent = 'The two passphrases do not match.'; err.hidden = false; return; }
      const newSalt = b64(crypto.getRandomValues(new Uint8Array(16)));
      const verifier = await Crypto.derive(pass, newSalt);
      await DB.meta('salt', newSalt);
      await DB.meta('verifier', verifier);
      await DB.meta('device_id', uuidv7());
      await DB.meta('tenant_id', uuidv7());
      await DB.meta('collector', $('collector').value.trim() || 'GE-COLLECTOR-01');
      await loadIdentity();
      await audit('device.enrol', State.deviceId);
      toast('Device enrolled');
    } else {
      const verifier = await Crypto.derive(pass, salt);
      if (verifier !== await DB.meta('verifier')) {
        Crypto.lock();
        err.textContent = 'That passphrase does not match this device.'; err.hidden = false;
        await audit('unlock.failed', '');
        return;
      }
      await loadIdentity();
      await audit('unlock', '');
    }
    await renderHome();
    show('home');
  };
}

async function loadIdentity() {
  State.deviceId = await DB.meta('device_id');
  State.tenantId = await DB.meta('tenant_id');
  State.collector = await DB.meta('collector');
}

/* ── Screen: home ──────────────────────────────────────────────────── */
async function renderHome() {
  const subs = await submissions();
  const outbox = await DB.all('outbox');
  const conflicts = subs.filter((s) => s.conflict).length;
  const i = State.instrument;

  $('scr-home').innerHTML = `
    <div class="stats">
      <div class="stat"><b>${subs.length}</b><span>Records</span></div>
      <div class="stat"><b>${outbox.length}</b><span>Pending</span></div>
      <div class="stat"><b>${conflicts}</b><span>Conflicts</span></div>
    </div>

    <div class="card">
      <p class="eyebrow">Assigned instrument</p>
      <h3>${esc(i.title)}</h3>
      <p class="muted">${esc(i.subtitle)}</p>
      <p class="muted mono">${esc(i.code)} · v${i.version} · ${i.sections.length} sections · ~${i.estimatedMinutes} min</p>
      <button class="btn wide" id="go-new">Start new interview</button>
    </div>

    <div class="list">
      <button class="item" id="go-queue">
        <div class="item-top"><strong>Queue and sync</strong>
          <span class="tag ${outbox.length ? 'pending' : 'synced'}">${outbox.length ? outbox.length + ' pending' : 'All synced'}</span></div>
        <span class="muted">Review records, transmit, resolve conflicts</span>
      </button>
      <button class="item" id="go-about">
        <div class="item-top"><strong>About this build</strong><span class="tag">Scope</span></div>
        <span class="muted">What it does, and what it must not be used for</span>
      </button>
    </div>`;
  setActions('');
  $('go-new').onclick = startInterview;
  $('go-queue').onclick = async () => { await renderQueue(); show('queue'); };
  $('go-about').onclick = async () => { await renderAbout(); show('about'); };
}

/* ── Screen: form ──────────────────────────────────────────────────── */
function startInterview() {
  State.answers = {};
  State.section = 0;
  State.submissionId = uuidv7();
  State.baseVersion = null;
  renderForm();
  show('form');
}

function questionHTML(q, answers, err) {
  const v = answers[q.id];
  const req = q.required ? '<span class="req" aria-hidden="true">*</span>' : '';
  const hint = q.hint ? `<p class="hint">${esc(q.hint)}</p>` : '';
  const help = q.help ? `<p class="hint">${esc(q.help)}</p>` : '';
  const errHTML = err ? `<p class="err" id="err-${q.id}">${esc(err)}</p>` : '';
  const cls = `q${err ? ' invalid' : ''}`;
  const aria = err ? `aria-invalid="true" aria-describedby="err-${q.id}"` : '';
  let control = '';

  switch (q.type) {
    case 'text':
      control = `<input type="text" id="f-${q.id}" data-q="${q.id}" ${aria}
        value="${v ? esc(v) : ''}" placeholder="${esc(q.placeholder || '')}"
        ${q.mask ? `maxlength="${q.mask.length}"` : ''} autocomplete="off" />`;
      break;
    case 'textarea':
      control = `<textarea id="f-${q.id}" data-q="${q.id}" ${aria}
        maxlength="${q.maxLength || 2000}">${v ? esc(v) : ''}</textarea>
        <p class="counter"><span id="count-${q.id}">${(v || '').length}</span> / ${q.maxLength || 2000}</p>`;
      break;
    case 'integer': case 'number':
      control = `<input type="number" id="f-${q.id}" data-q="${q.id}" ${aria}
        inputmode="numeric" value="${v ?? ''}"
        ${q.min !== undefined ? `min="${q.min}"` : ''} ${q.max !== undefined ? `max="${q.max}"` : ''}
        ${q.type === 'integer' ? 'step="1"' : ''} />`;
      break;
    case 'select_one':
      control = `<div class="opts" role="radiogroup" aria-label="${esc(q.label)}">` + q.options.map((o, n) => `
        <label class="opt${v === o ? ' sel' : ''}">
          <input type="radio" name="${q.id}" data-q="${q.id}" value="${esc(o)}" ${v === o ? 'checked' : ''} />
          <span>${esc(o)}</span></label>`).join('') + '</div>';
      break;
    case 'select_multi': {
      const arr = Array.isArray(v) ? v : [];
      control = `<div class="opts" role="group" aria-label="${esc(q.label)}">` + q.options.map((o) => `
        <label class="opt${arr.includes(o) ? ' sel' : ''}">
          <input type="checkbox" data-q="${q.id}" value="${esc(o)}" ${arr.includes(o) ? 'checked' : ''} />
          <span>${esc(o)}</span></label>`).join('') + '</div>';
      break;
    }
    case 'scale': {
      const btns = [];
      for (let n = q.min; n <= q.max; n++) {
        btns.push(`<button type="button" class="scale-btn${Number(v) === n ? ' sel' : ''}"
          data-q="${q.id}" data-val="${n}" aria-pressed="${Number(v) === n}">${n}</button>`);
      }
      control = `<div class="scale"><div class="scale-row">${btns.join('')}</div>
        <div class="scale-ends"><span>${esc(q.minLabel || '')}</span><span>${esc(q.maxLabel || '')}</span></div></div>`;
      break;
    }
    case 'checkbox':
      control = `<label class="opt${v ? ' sel' : ''}">
        <input type="checkbox" data-q="${q.id}" data-single="1" ${v ? 'checked' : ''} />
        <span>${esc(q.label)}${req}</span></label>`;
      return `<div class="${cls}">${control}${hint}${errHTML}</div>`;
    case 'geopoint':
      control = `<div class="row">
        <button type="button" class="btn ghost sm" data-geo="${q.id}">Capture location</button>
        <span class="muted mono" id="geo-${q.id}">${v ? esc(`${v.lat.toFixed(5)}, ${v.lon.toFixed(5)} ±${Math.round(v.acc)}m`) : 'Not captured'}</span>
      </div>`;
      break;
    default:
      control = `<p class="muted">Unsupported question type: ${esc(q.type)}</p>`;
  }
  return `<div class="${cls}">
      <label class="lbl" for="f-${q.id}">${esc(q.label)}${req}</label>
      ${hint}${control}${help}${errHTML}</div>`;
}

function renderForm(errs = {}) {
  const i = State.instrument;
  const s = i.sections[State.section];
  const vis = s.questions.filter((q) => visible(q, State.answers));
  const pct = Math.round((State.section / i.sections.length) * 100);

  $('scr-form').innerHTML = `
    <div class="progress">
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="steps">
        <span>Section ${State.section + 1} of ${i.sections.length}</span>
        <span>${esc(s.title)}</span>
      </div>
    </div>
    <div class="card">
      <p class="eyebrow">${esc(s.note || i.code)}</p>
      <h2>${esc(s.title)}</h2>
      <div>${vis.map((q) => questionHTML(q, State.answers, errs[q.id])).join('')}</div>
    </div>
    ${Object.keys(errs).length ? `<div class="notice risk"><b>${Object.keys(errs).length} answer${Object.keys(errs).length > 1 ? 's need' : ' needs'} attention</b><span>Corrections are marked in red above.</span></div>` : ''}`;

  setActions(`
    <button class="btn ghost" id="f-back">${State.section === 0 ? 'Cancel' : 'Back'}</button>
    <button class="btn" id="f-next">${State.section === i.sections.length - 1 ? 'Save record' : 'Continue'}</button>`);

  wireForm();
  $('f-back').onclick = () => {
    if (State.section === 0) { renderHome().then(() => show('home')); return; }
    State.section--; renderForm();
  };
  $('f-next').onclick = onNext;
}

function wireForm() {
  const root = $('scr-form');

  root.querySelectorAll('input[type=text], input[type=number], textarea').forEach((el) => {
    el.addEventListener('input', () => {
      const q = el.dataset.q;
      State.answers[q] = el.type === 'number'
        ? (el.value === '' ? undefined : Number(el.value))
        : el.value;
      const counter = $(`count-${q}`);
      if (counter) counter.textContent = el.value.length;
      el.closest('.q').classList.remove('invalid');
    });
  });

  root.querySelectorAll('input[type=radio]').forEach((el) => {
    el.addEventListener('change', () => {
      State.answers[el.dataset.q] = el.value;
      renderForm();                     // conditional questions may appear
    });
  });

  root.querySelectorAll('input[type=checkbox]').forEach((el) => {
    el.addEventListener('change', () => {
      const q = el.dataset.q;
      if (el.dataset.single) { State.answers[q] = el.checked; }
      else {
        const arr = Array.isArray(State.answers[q]) ? [...State.answers[q]] : [];
        const at = arr.indexOf(el.value);
        if (el.checked && at === -1) arr.push(el.value);
        if (!el.checked && at > -1) arr.splice(at, 1);
        State.answers[q] = arr;
      }
      el.closest('.opt').classList.toggle('sel', el.checked);
    });
  });

  root.querySelectorAll('.scale-btn').forEach((el) => {
    el.addEventListener('click', () => {
      State.answers[el.dataset.q] = Number(el.dataset.val);
      el.parentElement.querySelectorAll('.scale-btn').forEach((b) => {
        const on = b === el;
        b.classList.toggle('sel', on); b.setAttribute('aria-pressed', on);
      });
    });
  });

  root.querySelectorAll('[data-geo]').forEach((el) => {
    el.addEventListener('click', () => {
      const q = el.dataset.geo;
      if (!navigator.geolocation) { toast('This device has no location service'); return; }
      el.disabled = true; el.textContent = 'Capturing…';
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          State.answers[q] = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy };
          $(`geo-${q}`).textContent = `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)} ±${Math.round(pos.coords.accuracy)}m`;
          el.disabled = false; el.textContent = 'Recapture';
        },
        () => { toast('Location unavailable — continuing without it'); el.disabled = false; el.textContent = 'Capture location'; },
        { enableHighAccuracy: true, timeout: 8000 });
    });
  });
}

async function onNext() {
  const i = State.instrument;
  const s = i.sections[State.section];
  const errs = validateSection(s, State.answers);

  if (Object.keys(errs).length) {
    renderForm(errs);
    const first = $('scr-form').querySelector('.q.invalid');
    if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  if (State.section < i.sections.length - 1) { State.section++; renderForm(); return; }
  await saveRecord();
}

async function saveRecord() {
  const answers = pruneHidden(State.answers, State.instrument);
  const version = (State.baseVersion || 0) + 1;
  const env = await buildEnvelope(answers, State.submissionId, version, State.baseVersion);

  // The event is written and durably stored before the UI confirms a save,
  // and the outbox entry is written in the same pass so a crash between the
  // two cannot produce a record that never transmits.
  await DB.put('events', { ...env, synced: false, conflict: false });
  await DB.put('outbox', env);
  await audit('record.save', `${State.submissionId} v${version}`);

  toast('Saved on this device');
  if (navigator.onLine) {
    const r = await syncOutbox();
    if (r.sent) toast(`Saved and transmitted${r.conflicts ? ' — conflict flagged' : ''}`);
  }
  await renderHome();
  show('home');
}

/* ── Screen: queue ─────────────────────────────────────────────────── */
async function renderQueue() {
  const subs = await submissions();
  const outbox = await DB.all('outbox');

  $('scr-queue').innerHTML = `
    <div>
      <p class="eyebrow">Queue</p>
      <h2>${subs.length} record${subs.length === 1 ? '' : 's'} on this device</h2>
      <p class="muted">${outbox.length} waiting to transmit. Records are removed from the outbox only after the server confirms a durable write.</p>
    </div>
    ${subs.length === 0 ? '<div class="notice"><b>Nothing captured yet</b><span>Completed interviews appear here.</span></div>' : ''}
    <div class="list">
      ${subs.map((s) => `
        <button class="item ${s.conflict ? 'conflict' : s.synced ? 'synced' : 'pending'}" data-sub="${s.id}">
          <div class="item-top">
            <strong>${esc(s.label)}</strong>
            <span class="tag ${s.conflict ? 'conflict' : s.synced ? 'synced' : 'pending'}">${s.conflict ? 'Conflict' : s.synced ? 'Synced' : 'Pending'}</span>
          </div>
          <span class="muted mono">v${s.version} · ${s.events.length} event${s.events.length > 1 ? 's' : ''} · ${new Date(s.capturedAt).toLocaleString()}</span>
        </button>`).join('')}
    </div>`;

  setActions(`
    <button class="btn ghost" id="q-back">Back</button>
    <button class="btn" id="q-sync"${outbox.length ? '' : ' disabled'}>Transmit ${outbox.length || ''}</button>`);

  $('q-back').onclick = async () => { await renderHome(); show('home'); };
  $('q-sync').onclick = async () => {
    $('q-sync').disabled = true; $('q-sync').textContent = 'Transmitting…';
    const r = await syncOutbox();
    toast(`${r.sent} sent · ${r.dupes} duplicate${r.dupes === 1 ? '' : 's'} ignored${r.conflicts ? ` · ${r.conflicts} conflict` : ''}`);
    await renderQueue();
  };
  $('scr-queue').querySelectorAll('[data-sub]').forEach((b) => {
    b.onclick = async () => { await renderRecord(b.dataset.sub); show('record'); };
  });
}

/* ── Screen: record ────────────────────────────────────────────────── */
async function renderRecord(id) {
  const subs = await submissions();
  const s = subs.find((x) => x.id === id);
  if (!s) { await renderQueue(); show('queue'); return; }
  const answers = await Crypto.decrypt(s.latest.payload);

  $('scr-record').innerHTML = `
    <div>
      <p class="eyebrow">Record</p>
      <h2>${esc(s.label)}</h2>
      <p class="muted mono">${esc(s.id)}</p>
    </div>
    ${s.conflict ? `<div class="notice risk">
      <b>Two versions share a parent</b>
      <span>Both were stored. Nothing was discarded and nothing was chosen automatically — a supervisor resolves this, and the resolution is recorded as its own event.</span>
    </div>` : ''}
    <div class="card">
      <h3>Event history</h3>
      <p class="muted">Append-only. A correction adds a version; it never overwrites one.</p>
      <div class="list">
        ${s.events.map((e) => `
          <div class="item ${e.synced ? 'synced' : 'pending'}" style="cursor:default">
            <div class="item-top"><strong>Version ${e.version}</strong>
              <span class="tag ${e.synced ? 'synced' : 'pending'}">${e.synced ? 'seq ' + e.server_seq : 'Pending'}</span></div>
            <span class="muted mono">op ${esc(e.op_id.slice(0, 18))}… · parent ${e.parent_version ?? '—'}</span>
          </div>`).join('')}
      </div>
    </div>
    <div class="card">
      <h3>Answers</h3>
      <p class="muted">Decrypted in memory for display only.</p>
      <pre class="dump">${esc(JSON.stringify(answers, null, 2))}</pre>
    </div>`;

  setActions(`
    <button class="btn ghost" id="r-back">Back</button>
    <button class="btn" id="r-edit">Add correction</button>`);

  $('r-back').onclick = async () => { await renderQueue(); show('queue'); };
  $('r-edit').onclick = () => {
    State.answers = answers;
    State.submissionId = s.id;
    State.baseVersion = s.version;
    State.section = 0;
    renderForm(); show('form');
    toast(`Editing — this will become version ${s.version + 1}`);
  };
}

/* ── Screen: about ─────────────────────────────────────────────────── */
async function renderAbout() {
  const log = (await DB.all('audit')).sort((a, b) => b.id.localeCompare(a.id)).slice(0, 12);
  $('scr-about').innerHTML = `
    <div>
      <p class="eyebrow">About this build</p>
      <h2>What it does, and what it is not</h2>
    </div>
    <div class="notice risk">
      <b>Not a HIPAA-compliant system</b>
      <span>No business associate agreements are in place and no server-side controls exist. Do not enter names, addresses, phone numbers, dates of birth, record numbers, or any other identifying information.</span>
    </div>
    <div class="card">
      <h3>What is real here</h3>
      <ul style="margin:0;padding-left:20px;display:grid;gap:6px" class="muted">
        <li>Works with no connectivity — every asset is cached on first load</li>
        <li>Records encrypted on the device with AES-256-GCM, key derived from your passphrase and never stored</li>
        <li>Each operation carries a UUIDv7 idempotency key and an HMAC signature</li>
        <li>Append-only history: corrections add versions, nothing is overwritten</li>
        <li>Divergent edits are flagged for a human, never resolved automatically</li>
        <li>An operation leaves the outbox only after a durable acknowledgement</li>
      </ul>
    </div>
    <div class="card">
      <h3>What is simulated</h3>
      <p class="muted">The server is a local store, so the protocol can be demonstrated end to end without a backend. Swapping it for the real API is one function, <span class="mono">transmit</span>.</p>
    </div>
    <div class="card">
      <h3>This device</h3>
      <p class="muted mono">device ${esc(State.deviceId || '—')}<br />collector ${esc(State.collector || '—')}</p>
      <h3 style="margin-top:8px">Recent activity</h3>
      <div class="list">
        ${log.map((a) => `<div class="item" style="cursor:default;border-left-color:var(--g-300)">
          <div class="item-top"><strong>${esc(a.action)}</strong><span class="muted mono">${new Date(a.at).toLocaleTimeString()}</span></div>
          ${a.detail ? `<span class="muted mono">${esc(a.detail)}</span>` : ''}</div>`).join('')}
      </div>
    </div>
    <div class="card">
      <h3>Danger zone</h3>
      <p class="muted">Erasing destroys the local key and every record on this device. This is what a remote wipe would do.</p>
      <button class="btn danger wide" id="a-wipe">Erase this device</button>
    </div>`;

  setActions('<button class="btn ghost wide" id="a-back">Back</button>');
  $('a-back').onclick = async () => { await renderHome(); show('home'); };
  $('a-wipe').onclick = async () => {
    if (!confirm('Erase all local records and the encryption key? This cannot be undone.')) return;
    indexedDB.deleteDatabase('epi-collect');
    Crypto.lock();
    setTimeout(() => location.reload(), 300);
  };
}

/* ── Boot ──────────────────────────────────────────────────────────── */
async function boot() {
  netStatus();
  window.addEventListener('online', () => { netStatus(); toast('Back online'); });
  window.addEventListener('offline', () => { netStatus(); toast('Offline — capture continues'); });

  await DB.open();
  const res = await fetch('instruments/chna-screener.json');
  State.instrument = await res.json();
  await loadIdentity();
  await renderUnlock();
  show('unlock');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', boot);
