/* =====================================================================
   GLOBAL EPI — Field Collect
   ---------------------------------------------------------------------
   A survey tool, not an app with a survey inside it. Anyone can build an
   instrument here — sections, questions, validation rules, conditional
   logic — preview it exactly as a collector will see it, and then run it
   offline. Instruments live on the device and can be exported, shared as
   JSON, and imported on another device.

   The collection layer implements the synchronisation protocol from the
   platform architecture: UUIDv7 operation ids, an append-only event log,
   at-least-once delivery from an outbox, idempotent ingest, and
   divergence surfaced as a conflict rather than silently resolved.

   PILOT SCOPE: no identifying information. Not a HIPAA-compliant system.
===================================================================== */
'use strict';

/* ── UUIDv7 ──────────────────────────────────────────────────────── */
function uuidv7() {
  const ts = BigInt(Date.now());
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[0] = Number((ts >> 40n) & 0xffn); b[1] = Number((ts >> 32n) & 0xffn);
  b[2] = Number((ts >> 24n) & 0xffn); b[3] = Number((ts >> 16n) & 0xffn);
  b[4] = Number((ts >> 8n) & 0xffn);  b[5] = Number(ts & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
/* Ids for sections and questions must be random, not time-derived. The
   leading hex of a UUIDv7 is its millisecond timestamp, whose top bits only
   change about once a minute — anything built in the same sitting collided,
   which silently pointed conditional rules at the wrong question. */
function shortId() {
  const b = new Uint8Array(5);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/* ── Crypto ──────────────────────────────────────────────────────── */
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
    return b64(await crypto.subtle.digest('SHA-256', raw.slice(0, 32)));
  },
  async encrypt(obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.aesKey, enc.encode(JSON.stringify(obj)));
    return { iv: b64(iv), ct: b64(ct) };
  },
  async decrypt(payload) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(payload.iv) }, this.aesKey, unb64(payload.ct));
    return JSON.parse(dec.decode(pt));
  },
  async sign(str) { return b64(await crypto.subtle.sign('HMAC', this.macKey, enc.encode(str))); },
  verify(str, sig) { return crypto.subtle.verify('HMAC', this.macKey, unb64(sig), enc.encode(str)); },
  lock() { this.aesKey = null; this.macKey = null; },
};

/* ── Storage ─────────────────────────────────────────────────────── */
const DB = {
  db: null,
  async open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('epi-collect', 2);
      r.onupgradeneeded = (e) => {
        const d = r.result;
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'k' });
        if (!d.objectStoreNames.contains('events')) {
          d.createObjectStore('events', { keyPath: 'op_id' }).createIndex('submission', 'submission_id');
        }
        if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'op_id' });
        if (!d.objectStoreNames.contains('server')) {
          d.createObjectStore('server', { keyPath: 'key' }).createIndex('submission', 'submission_id');
        }
        if (!d.objectStoreNames.contains('audit')) d.createObjectStore('audit', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('instruments')) d.createObjectStore('instruments', { keyPath: 'id' });
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(s, m = 'readonly') { return this.db.transaction(s, m).objectStore(s); },
  req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  get(s, k) { return this.req(this.tx(s).get(k)); },
  all(s) { return this.req(this.tx(s).getAll()); },
  put(s, v) { return this.req(this.tx(s, 'readwrite').put(v)); },
  del(s, k) { return this.req(this.tx(s, 'readwrite').delete(k)); },
  async meta(k, v) {
    if (v === undefined) { const r = await this.get('meta', k); return r ? r.v : null; }
    return this.put('meta', { k, v });
  },
};

async function audit(action, detail) {
  await DB.put('audit', { id: uuidv7(), at: new Date().toISOString(),
    collector: State.collector, device: State.deviceId, action, detail: detail || '' });
}

/* ── State ───────────────────────────────────────────────────────── */
const State = {
  instruments: [], instrument: null,
  deviceId: null, tenantId: null, collector: null,
  answers: {}, section: 0, preview: false, shuffled: {}, analysisId: null,
  submissionId: null, baseVersion: null,
  draft: null, sectionIdx: 0, questionIdx: 0,   // builder cursors
};

/* ── Question types the builder offers ───────────────────────────── */
const QTYPES = [
  { t: 'text',         name: 'Short text',   desc: 'One line, optional format mask' },
  { t: 'textarea',     name: 'Long text',    desc: 'Paragraph, with a length limit' },
  { t: 'integer',      name: 'Whole number', desc: 'Counts, ages, minutes' },
  { t: 'number',       name: 'Decimal',      desc: 'Measurements' },
  { t: 'select_one',   name: 'Choose one',   desc: 'Radio list' },
  { t: 'dropdown',     name: 'Dropdown',     desc: 'Choose one from a long list' },
  { t: 'yesno',        name: 'Yes / No',     desc: 'Two-button answer' },
  { t: 'select_multi', name: 'Choose many',  desc: 'Checkbox list, capped' },
  { t: 'scale',        name: 'Rating scale', desc: 'Numeric range with end labels' },
  { t: 'matrix',       name: 'Matrix',       desc: 'Several rows on one shared scale' },
  { t: 'ranking',      name: 'Ranking',      desc: 'Put the options in order' },
  { t: 'date',         name: 'Date',         desc: 'Calendar picker' },
  { t: 'checkbox',     name: 'Confirmation', desc: 'A single tick box' },
  { t: 'geopoint',     name: 'Location',     desc: 'Device coordinates' },
];
const typeName = (t) => (QTYPES.find((x) => x.t === t) || { name: t }).name;
const hasOptions = (t) => ['select_one', 'select_multi', 'dropdown', 'ranking'].includes(t);
const pickOne = (t) => ['select_one', 'dropdown', 'yesno'].includes(t);

/* ── Instrument logic ────────────────────────────────────────────── */
function visible(q, answers) {
  const c = q.showIf;
  if (!c || !c.q) return true;
  const v = answers[c.q];
  if (c.eq !== undefined) return v === c.eq;
  if (c.notEq !== undefined) return v !== undefined && v !== null && v !== '' && v !== c.notEq;
  if (c.in !== undefined) return Array.isArray(c.in) && c.in.includes(v);
  return true;
}
function maskToRegex(mask) {
  return new RegExp('^' + [...mask].map((ch) =>
    ch === 'A' ? '[A-Za-z]' : ch === '0' ? '[0-9]' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$');
}
function validateQuestion(q, answers) {
  if (!visible(q, answers)) return null;
  const v = answers[q.id];
  const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0) || v === false
    || (q.type === 'matrix' && Object.keys(v || {}).length === 0);
  if (q.required && empty) return q.type === 'checkbox' ? 'This must be confirmed to continue.' : 'This answer is required.';
  if (empty) return null;
  if (q.type === 'text' && q.mask && !maskToRegex(q.mask).test(v)) {
    return `Use the format ${q.mask.replace(/A/g, 'X').replace(/0/g, '9')}${q.placeholder ? ` — for example ${q.placeholder}` : ''}.`;
  }
  if (q.maxLength && String(v).length > q.maxLength) return `Keep this under ${q.maxLength} characters.`;
  if (q.type === 'integer' || q.type === 'number' || q.type === 'scale') {
    const n = Number(v);
    if (!Number.isFinite(n)) return 'Enter a number.';
    if (q.type === 'integer' && !Number.isInteger(n)) return 'Enter a whole number.';
    if (q.min !== undefined && q.min !== null && n < q.min) return `Cannot be less than ${q.min}.`;
    if (q.max !== undefined && q.max !== null && n > q.max) return `Cannot be more than ${q.max}.`;
  }
  if (q.atMostField && q.atMostField.field) {
    const cap = Number(answers[q.atMostField.field]);
    if (Number.isFinite(cap) && Number(v) > cap) return q.atMostField.message || 'Cannot exceed the earlier answer.';
  }
  if (q.maxSelections && Array.isArray(v) && v.length > q.maxSelections) return `Choose no more than ${q.maxSelections}.`;
  if (q.type === 'matrix' && q.required) {
    const missing = (q.rows || []).filter((r) => v[r] === undefined || v[r] === null);
    if (missing.length) return `Rate every row — ${missing.length} still blank.`;
  }
  if (q.type === 'ranking' && q.required && Array.isArray(v) && v.length !== (q.options || []).length) {
    return 'Put every option in order.';
  }
  return null;
}
function validateSection(section, answers) {
  const errs = {};
  section.questions.forEach((q) => { const e = validateQuestion(q, answers); if (e) errs[q.id] = e; });
  return errs;
}
function pruneHidden(answers, instrument) {
  const out = { ...answers };
  instrument.sections.forEach((s) => s.questions.forEach((q) => { if (!visible(q, out)) delete out[q.id]; }));
  return out;
}
const allQuestions = (inst) => inst.sections.flatMap((s) => s.questions);

/* Option order is randomised once per response, not per render — otherwise
   the list would reshuffle under the interviewer's finger. */
function optionsFor(q) {
  const base = q.options || [];
  if (!q.randomize) return base;
  if (!State.shuffled[q.id]) {
    const a = [...base];
    for (let i = a.length - 1; i > 0; i--) {
      const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    State.shuffled[q.id] = a;
  }
  return State.shuffled[q.id];
}

/* ── Sync protocol ───────────────────────────────────────────────── */
async function buildEnvelope(answers, submissionId, version, parentVersion) {
  const payload = await Crypto.encrypt(answers);
  const env = {
    op_id: uuidv7(), tenant_id: State.tenantId,
    instrument_id: State.instrument.id, instrument_version: State.instrument.version,
    submission_id: submissionId, version, parent_version: parentVersion,
    device_id: State.deviceId, collector_id: State.collector,
    captured_at_device: new Date().toISOString(), payload,
  };
  env.payload_hmac = await Crypto.sign(`${env.op_id}|${env.submission_id}|${env.version}|${env.payload.ct}`);
  return env;
}
async function transmit(env) {
  const key = `${env.tenant_id}:${env.op_id}`;
  const existing = await DB.get('server', key);
  if (existing) return { status: 'duplicate', op_id: env.op_id, server_seq: existing.server_seq };
  const ok = await Crypto.verify(`${env.op_id}|${env.submission_id}|${env.version}|${env.payload.ct}`, env.payload_hmac);
  if (!ok) return { status: 'quarantined', op_id: env.op_id };
  const log = await DB.all('server');
  const sameParent = log.filter((e) => e.submission_id === env.submission_id && e.version === env.version);
  const seq = (Number(await DB.meta('server_seq')) || 0) + 1;
  await DB.meta('server_seq', seq);
  await DB.put('server', { key, server_seq: seq, received_at: new Date().toISOString(), ...env });
  return { status: 'accepted', op_id: env.op_id, server_seq: seq, conflict: sameParent.length > 0 };
}
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
      local.synced = true; local.server_seq = ack.server_seq; local.conflict = !!ack.conflict;
      await DB.put('events', local);
    }
    await DB.del('outbox', env.op_id);
  }
  await audit('sync', `sent ${sent}, duplicates ${dupes}, conflicts ${conflicts}, failed ${failed}`);
  return { sent, dupes, conflicts, failed };
}

async function submissions(instrumentId) {
  const events = (await DB.all('events')).filter((e) => !instrumentId || e.instrument_id === instrumentId);
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
    const inst = State.instruments.find((i) => i.id === latest.instrument_id);
    let label = '—';
    try {
      const a = await Crypto.decrypt(latest.payload);
      const lf = inst && inst.labelField;
      label = (lf && a[lf] != null && a[lf] !== '' ? String(a[lf]) : null) || '—';
    } catch { label = '(locked)'; }
    out.push({ id, events: evs, latest, label, instrumentTitle: inst ? inst.title : 'Unknown survey',
      version: latest.version,
      conflict: evs.some((e) => e.conflict) || new Set(versions).size !== versions.length,
      synced: evs.every((e) => e.synced), capturedAt: evs[0].captured_at_device });
  }
  return out.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
}

/* ── Builder model ───────────────────────────────────────────────── */
function freshId(prefix, taken) {
  let id;
  do { id = `${prefix}_${shortId()}`; } while (taken.includes(id));
  return id;
}
function newQuestion(type = 'text', taken = []) {
  const q = { id: freshId('q', taken), type, label: '', required: false };
  if (hasOptions(type)) q.options = ['Option 1', 'Option 2'];
  if (type === 'scale') { q.min = 1; q.max = 5; q.minLabel = ''; q.maxLabel = ''; }
  if (type === 'matrix') { q.rows = ['Row 1', 'Row 2']; q.min = 1; q.max = 5; q.minLabel = ''; q.maxLabel = ''; }
  return q;
}
function newSection(n = 1, taken = []) {
  return { id: freshId('s', taken), title: `Section ${n}`, note: '', questions: [] };
}
function newSurvey() {
  return {
    id: uuidv7(), version: 1, code: 'NEW', title: 'Untitled survey', subtitle: '',
    locale: 'en', estimatedMinutes: 5, labelField: null,
    sections: [newSection(1)], updatedAt: new Date().toISOString(),
  };
}
function move(arr, i, dir) {
  const j = i + dir;
  if (j < 0 || j >= arr.length) return arr;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  return arr;
}
/* A survey is only runnable if every question can actually be answered. */
function surveyProblems(inst) {
  const p = [];
  if (!inst.title.trim()) p.push('The survey needs a title.');
  if (!inst.sections.length) p.push('Add at least one section.');
  inst.sections.forEach((s, si) => {
    if (!s.questions.length) p.push(`“${s.title}” has no questions.`);
    s.questions.forEach((q, qi) => {
      const where = `Section ${si + 1}, question ${qi + 1}`;
      if (!q.label.trim()) p.push(`${where} has no wording.`);
      if (hasOptions(q.type) && (!q.options || q.options.filter((o) => o.trim()).length < 2)) {
        p.push(`${where} needs at least two options.`);
      }
      if ((q.type === 'scale' || q.type === 'matrix') && !(q.max > q.min)) p.push(`${where} needs a range where the top is above the bottom.`);
      if (q.type === 'matrix' && (!q.rows || q.rows.filter((r) => r.trim()).length < 1)) p.push(`${where} needs at least one row.`);
    });
  });
  return p;
}

/* ── View helpers ────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
const SCREENS = ['unlock', 'home', 'form', 'queue', 'record', 'builder', 'section', 'question', 'preview', 'analysis', 'about'];
function show(name) { SCREENS.forEach((s) => { $(`scr-${s}`).hidden = s !== name; }); window.scrollTo(0, 0); }
function setActions(html) { const b = $('actionbar'); b.innerHTML = html || ''; b.hidden = !html; }
function netStatus() {
  const on = navigator.onLine;
  $('netdot').classList.toggle('on', on);
  $('nettext').textContent = on ? 'Online' : 'Offline';
}
async function saveDraft() {
  State.draft.updatedAt = new Date().toISOString();
  await DB.put('instruments', State.draft);
  State.instruments = await DB.all('instruments');
}

/* ── Unlock ──────────────────────────────────────────────────────── */
async function renderUnlock() {
  const salt = await DB.meta('salt');
  const first = !salt;
  $('scr-unlock').innerHTML = `
    <div class="card">
      <p class="eyebrow">${first ? 'Set up this device' : 'Unlock'}</p>
      <h2>${first ? 'Create a device passphrase' : 'Enter your passphrase'}</h2>
      <p class="muted">${first
        ? 'Responses saved on this device are encrypted with a key derived from this passphrase. It is never stored and cannot be recovered.'
        : 'This releases the key that decrypts responses held on this device.'}</p>
      <div class="q"><label class="lbl" for="pass">Passphrase</label>
        <input id="pass" type="password" autocomplete="current-password" />
        <p class="err" id="pass-err" hidden></p></div>
      ${first ? `
      <div class="q"><label class="lbl" for="pass2">Confirm passphrase</label>
        <input id="pass2" type="password" autocomplete="new-password" /></div>
      <div class="q"><label class="lbl" for="collector">Your identifier</label>
        <p class="hint">A staff code, not a name.</p>
        <input id="collector" type="text" value="GE-USER-01" /></div>` : ''}
      <button class="btn wide" id="do-unlock">${first ? 'Create and continue' : 'Unlock'}</button>
    </div>
    <div class="notice warn"><b>Pilot scope</b>
      <span>Non-identifying data only. This is not a HIPAA-compliant system.</span></div>`;
  setActions('');
  $('do-unlock').onclick = async () => {
    const pass = $('pass').value, err = $('pass-err');
    err.hidden = true;
    if (pass.length < 8) { err.textContent = 'Use at least 8 characters.'; err.hidden = false; return; }
    if (first) {
      if (pass !== $('pass2').value) { err.textContent = 'The two passphrases do not match.'; err.hidden = false; return; }
      const newSalt = b64(crypto.getRandomValues(new Uint8Array(16)));
      await DB.meta('verifier', await Crypto.derive(pass, newSalt));
      await DB.meta('salt', newSalt);
      await DB.meta('device_id', uuidv7());
      await DB.meta('tenant_id', uuidv7());
      await DB.meta('collector', $('collector').value.trim() || 'GE-USER-01');
      await loadIdentity();
      await seedStarter();
      await audit('device.enrol', State.deviceId);
      toast('Device ready');
    } else {
      if (await Crypto.derive(pass, salt) !== await DB.meta('verifier')) {
        Crypto.lock();
        err.textContent = 'That passphrase does not match this device.'; err.hidden = false;
        await audit('unlock.failed', ''); return;
      }
      await loadIdentity();
      await audit('unlock', '');
    }
    State.instruments = await DB.all('instruments');
    await renderHome(); show('home');
  };
}
async function loadIdentity() {
  State.deviceId = await DB.meta('device_id');
  State.tenantId = await DB.meta('tenant_id');
  State.collector = await DB.meta('collector');
}
/* One worked example so the library is not empty on first run. It is an
   ordinary survey: editable, duplicable, deletable like any other. */
async function seedStarter() {
  if ((await DB.all('instruments')).length) return;
  try {
    const res = await fetch('instruments/chna-screener.json');
    const inst = await res.json();
    inst.updatedAt = new Date().toISOString();
    await DB.put('instruments', inst);
  } catch { /* offline first run: the library simply starts empty */ }
}

/* ── Library (home) ──────────────────────────────────────────────── */
async function renderHome() {
  const subs = await submissions();
  const outbox = await DB.all('outbox');
  const conflicts = subs.filter((s) => s.conflict).length;
  const counts = new Map();
  subs.forEach((s) => counts.set(s.latest.instrument_id, (counts.get(s.latest.instrument_id) || 0) + 1));

  $('scr-home').innerHTML = `
    <div class="stats">
      <div class="stat"><b>${State.instruments.length}</b><span>Surveys</span></div>
      <div class="stat"><b>${subs.length}</b><span>Responses</span></div>
      <div class="stat"><b>${outbox.length}</b><span>Pending</span></div>
    </div>

    <div>
      <p class="eyebrow">Your surveys</p>
      <h2 style="margin-top:4px">Build, preview, collect</h2>
      <p class="muted" style="margin-top:6px">Design a questionnaire here, then run it in the field with no connectivity.</p>
    </div>

    ${State.instruments.length === 0 ? `
      <div class="notice"><b>No surveys yet</b><span>Create your first one below.</span></div>` : ''}

    <div class="list">
      ${State.instruments.map((i) => {
        const n = counts.get(i.id) || 0;
        const probs = surveyProblems(i).length;
        return `
        <div class="card" style="padding:16px">
          <div class="item-top">
            <strong style="font-size:1rem;color:var(--navy-900)">${esc(i.title)}</strong>
            <span class="tag ${probs ? 'pending' : 'synced'}">${probs ? 'Draft' : 'Ready'}</span>
          </div>
          <p class="muted" style="font-size:.84rem">${esc(i.code)} · v${i.version} ·
            ${i.sections.length} section${i.sections.length === 1 ? '' : 's'} ·
            ${allQuestions(i).length} question${allQuestions(i).length === 1 ? '' : 's'}${n ? ` · ${n} response${n === 1 ? '' : 's'}` : ''}</p>
          <div class="row">
            <button class="btn sm" data-run="${i.id}"${probs ? ' disabled' : ''}>Collect</button>
            <button class="btn ghost sm" data-edit="${i.id}">Edit</button>
            <button class="btn ghost sm" data-prev="${i.id}"${probs ? ' disabled' : ''}>Preview</button>
            <button class="btn ghost sm" data-an="${i.id}">Analyse</button>
            <button class="btn ghost sm" data-exp="${i.id}">Export</button>
          </div>
          ${probs ? `<p class="err" style="font-size:.82rem">${probs} thing${probs === 1 ? '' : 's'} to finish before it can run.</p>` : ''}
        </div>`; }).join('')}
    </div>

    <div class="row">
      <button class="btn wide" id="go-newsurvey">Create a survey</button>
    </div>
    <div class="row">
      <button class="btn ghost sm" id="go-import">Import from file</button>
      <button class="btn ghost sm" id="go-queue">Responses${outbox.length ? ` (${outbox.length} pending)` : ''}</button>
      <button class="btn ghost sm" id="go-about">About</button>
    </div>
    ${conflicts ? `<div class="notice risk"><b>${conflicts} conflict${conflicts > 1 ? 's' : ''} to resolve</b><span>Two versions share a parent. Open Responses to review.</span></div>` : ''}
    <input type="file" id="import-file" accept="application/json" hidden />`;

  setActions('');
  $('go-newsurvey').onclick = async () => {
    State.draft = newSurvey(); await saveDraft();
    await audit('survey.create', State.draft.id);
    renderBuilder(); show('builder');
  };
  $('go-queue').onclick = async () => { await renderQueue(); show('queue'); };
  $('go-about').onclick = async () => { await renderAbout(); show('about'); };
  $('go-import').onclick = () => $('import-file').click();
  $('import-file').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const inst = JSON.parse(await f.text());
      if (!inst.sections || !Array.isArray(inst.sections)) throw new Error('shape');
      inst.id = uuidv7(); inst.updatedAt = new Date().toISOString();
      await DB.put('instruments', inst);
      State.instruments = await DB.all('instruments');
      await audit('survey.import', inst.title || '');
      toast('Survey imported'); await renderHome();
    } catch { toast('That file is not a survey definition'); }
  };
  $('scr-home').querySelectorAll('[data-run]').forEach((b) => b.onclick = () => startInterview(b.dataset.run));
  $('scr-home').querySelectorAll('[data-prev]').forEach((b) => b.onclick = () => startPreview(b.dataset.prev));
  $('scr-home').querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => {
    State.draft = JSON.parse(JSON.stringify(State.instruments.find((i) => i.id === b.dataset.edit)));
    renderBuilder(); show('builder');
  });
  $('scr-home').querySelectorAll('[data-an]').forEach((b) => b.onclick = async () => {
    await renderAnalysis(b.dataset.an); show('analysis');
  });
  $('scr-home').querySelectorAll('[data-exp]').forEach((b) => b.onclick = () => {
    const i = State.instruments.find((x) => x.id === b.dataset.exp);
    const blob = new Blob([JSON.stringify(i, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(i.code || 'survey').toLowerCase()}-v${i.version}.json`;
    a.click(); URL.revokeObjectURL(a.href);
    toast('Exported');
  });
}

/* ── Builder: survey ─────────────────────────────────────────────── */
function renderBuilder() {
  const d = State.draft;
  const probs = surveyProblems(d);
  const labelable = allQuestions(d).filter((q) => ['text', 'integer', 'number', 'date'].includes(q.type));

  $('scr-builder').innerHTML = `
    <div>
      <p class="eyebrow">Survey builder</p>
      <h2 style="margin-top:4px">${esc(d.title || 'Untitled survey')}</h2>
    </div>

    <div class="card">
      <div class="q"><label class="lbl" for="b-title">Title</label>
        <input id="b-title" type="text" value="${esc(d.title)}" placeholder="Community Health Needs Assessment" /></div>
      <div class="q"><label class="lbl" for="b-sub">Description</label>
        <input id="b-sub" type="text" value="${esc(d.subtitle || '')}" placeholder="Shown under the title" /></div>
      <div class="q"><label class="lbl" for="b-code">Short code</label>
        <p class="hint">Used in exports and file names.</p>
        <input id="b-code" type="text" value="${esc(d.code || '')}" placeholder="CHNA-SCR" /></div>
      <div class="q"><label class="lbl" for="b-mins">Estimated minutes</label>
        <input id="b-mins" type="number" min="1" max="180" value="${d.estimatedMinutes || 5}" /></div>
      <div class="q"><label class="lbl" for="b-label">Label responses by</label>
        <p class="hint">Which answer identifies a response in the list.</p>
        <select id="b-label">
          <option value="">— none —</option>
          ${labelable.map((q) => `<option value="${q.id}"${d.labelField === q.id ? ' selected' : ''}>${esc(q.label || q.id)}</option>`).join('')}
        </select></div>
    </div>

    <div>
      <p class="eyebrow">Sections</p>
      <div class="list" style="margin-top:10px">
        ${d.sections.map((s, i) => `
          <div class="rowitem">
            <button class="grab" data-sec="${i}">
              <strong>${esc(s.title || 'Untitled section')}</strong>
              <span>${s.questions.length} question${s.questions.length === 1 ? '' : 's'}</span>
            </button>
            <div class="ctrls">
              <button class="iconbtn" data-secup="${i}"${i === 0 ? ' disabled' : ''} aria-label="Move up">↑</button>
              <button class="iconbtn" data-secdown="${i}"${i === d.sections.length - 1 ? ' disabled' : ''} aria-label="Move down">↓</button>
              <button class="iconbtn" data-secdup="${i}" aria-label="Duplicate section">⧉</button>
              <button class="iconbtn del" data-secdel="${i}" aria-label="Delete section">✕</button>
            </div>
          </div>`).join('')}
      </div>
      <button class="btn ghost wide sm" id="b-addsec" style="margin-top:10px">Add section</button>
    </div>

    ${probs.length ? `<div class="notice warn"><b>Before it can run</b>
      <span>${probs.slice(0, 4).map(esc).join('<br />')}${probs.length > 4 ? `<br />…and ${probs.length - 4} more` : ''}</span></div>`
      : '<div class="notice"><b>Ready to collect</b><span>Every question is answerable. Preview it to check the flow.</span></div>'}

    <button class="btn danger wide sm" id="b-delete">Delete this survey</button>`;

  setActions(`
    <button class="btn ghost" id="b-back">Done</button>
    <button class="btn" id="b-preview"${probs.length ? ' disabled' : ''}>Preview</button>`);

  const bind = (id, key, num) => {
    $(id).addEventListener('input', async (e) => {
      State.draft[key] = num ? Number(e.target.value) : e.target.value;
      await saveDraft();
    });
  };
  bind('b-title', 'title'); bind('b-sub', 'subtitle'); bind('b-code', 'code'); bind('b-mins', 'estimatedMinutes', true);
  $('b-label').onchange = async (e) => { State.draft.labelField = e.target.value || null; await saveDraft(); };

  $('b-addsec').onclick = async () => {
    d.sections.push(newSection(d.sections.length + 1, d.sections.map((x) => x.id)));
    await saveDraft(); renderBuilder();
  };
  $('scr-builder').querySelectorAll('[data-sec]').forEach((b) => b.onclick = () => {
    State.sectionIdx = Number(b.dataset.sec); renderSection(); show('section');
  });
  $('scr-builder').querySelectorAll('[data-secup]').forEach((b) => b.onclick = async () => {
    move(d.sections, Number(b.dataset.secup), -1); await saveDraft(); renderBuilder();
  });
  $('scr-builder').querySelectorAll('[data-secdown]').forEach((b) => b.onclick = async () => {
    move(d.sections, Number(b.dataset.secdown), 1); await saveDraft(); renderBuilder();
  });
  $('scr-builder').querySelectorAll('[data-secdup]').forEach((b) => b.onclick = async () => {
    const i = Number(b.dataset.secdup);
    const copy = JSON.parse(JSON.stringify(d.sections[i]));
    copy.id = freshId('s', d.sections.map((x) => x.id));
    copy.title = `${copy.title} (copy)`;
    const taken = allQuestions(d).map((x) => x.id);
    // Copied questions need fresh ids, and any rule pointing inside the
    // section has to be repointed at the copy rather than the original.
    const remap = {};
    copy.questions.forEach((cq) => { const nid = freshId('q', taken.concat(Object.values(remap))); remap[cq.id] = nid; cq.id = nid; });
    copy.questions.forEach((cq) => { if (cq.showIf && remap[cq.showIf.q]) cq.showIf.q = remap[cq.showIf.q];
      if (cq.atMostField && remap[cq.atMostField.field]) cq.atMostField.field = remap[cq.atMostField.field]; });
    d.sections.splice(i + 1, 0, copy);
    await saveDraft(); renderBuilder();
  });
  $('scr-builder').querySelectorAll('[data-secdel]').forEach((b) => b.onclick = async () => {
    const i = Number(b.dataset.secdel);
    if (!confirm(`Delete “${d.sections[i].title}” and its questions?`)) return;
    d.sections.splice(i, 1); await saveDraft(); renderBuilder();
  });
  $('b-delete').onclick = async () => {
    if (!confirm('Delete this survey? Responses already collected are kept.')) return;
    await DB.del('instruments', d.id);
    State.instruments = await DB.all('instruments');
    await audit('survey.delete', d.id);
    await renderHome(); show('home');
  };
  $('b-back').onclick = async () => {
    State.draft.version += 1; await saveDraft();
    await renderHome(); show('home');
  };
  $('b-preview').onclick = () => startPreview(d.id);
}

/* ── Builder: section ────────────────────────────────────────────── */
function renderSection() {
  const d = State.draft, s = d.sections[State.sectionIdx];
  $('scr-section').innerHTML = `
    <div><p class="eyebrow">Section ${State.sectionIdx + 1} of ${d.sections.length}</p>
      <h2 style="margin-top:4px">${esc(s.title || 'Untitled section')}</h2></div>
    <div class="card">
      <div class="q"><label class="lbl" for="s-title">Section title</label>
        <input id="s-title" type="text" value="${esc(s.title)}" /></div>
      <div class="q"><label class="lbl" for="s-note">Note above the questions</label>
        <p class="hint">Optional context for the interviewer.</p>
        <input id="s-note" type="text" value="${esc(s.note || '')}" /></div>
    </div>
    <div>
      <p class="eyebrow">Questions</p>
      <div class="list" style="margin-top:10px">
        ${s.questions.length === 0 ? '<p class="muted">No questions yet.</p>' : ''}
        ${s.questions.map((q, i) => `
          <div class="rowitem">
            <button class="grab" data-q="${i}">
              <strong>${esc(q.label || 'Untitled question')}</strong>
              <span>${esc(typeName(q.type))}${q.required ? ' · required' : ''}${q.showIf && q.showIf.q ? ' · conditional' : ''}</span>
            </button>
            <div class="ctrls">
              <button class="iconbtn" data-qup="${i}"${i === 0 ? ' disabled' : ''} aria-label="Move up">↑</button>
              <button class="iconbtn" data-qdown="${i}"${i === s.questions.length - 1 ? ' disabled' : ''} aria-label="Move down">↓</button>
              <button class="iconbtn" data-qdup="${i}" aria-label="Duplicate question">⧉</button>
              <button class="iconbtn del" data-qdel="${i}" aria-label="Delete question">✕</button>
            </div>
          </div>`).join('')}
      </div>
      <button class="btn ghost wide sm" id="s-addq" style="margin-top:10px">Add question</button>
    </div>`;

  setActions('<button class="btn ghost wide" id="s-back">Back to survey</button>');

  $('s-title').addEventListener('input', async (e) => { s.title = e.target.value; await saveDraft(); });
  $('s-note').addEventListener('input', async (e) => { s.note = e.target.value; await saveDraft(); });
  $('s-addq').onclick = async () => {
    s.questions.push(newQuestion('text', allQuestions(State.draft).map((x) => x.id)));
    State.questionIdx = s.questions.length - 1;
    await saveDraft(); renderQuestion(); show('question');
  };
  $('scr-section').querySelectorAll('[data-q]').forEach((b) => b.onclick = () => {
    State.questionIdx = Number(b.dataset.q); renderQuestion(); show('question');
  });
  $('scr-section').querySelectorAll('[data-qup]').forEach((b) => b.onclick = async () => {
    move(s.questions, Number(b.dataset.qup), -1); await saveDraft(); renderSection();
  });
  $('scr-section').querySelectorAll('[data-qdown]').forEach((b) => b.onclick = async () => {
    move(s.questions, Number(b.dataset.qdown), 1); await saveDraft(); renderSection();
  });
  $('scr-section').querySelectorAll('[data-qdup]').forEach((b) => b.onclick = async () => {
    const i = Number(b.dataset.qdup);
    const copy = JSON.parse(JSON.stringify(s.questions[i]));
    copy.id = freshId('q', allQuestions(State.draft).map((x) => x.id));
    copy.label = `${copy.label} (copy)`;
    s.questions.splice(i + 1, 0, copy);
    await saveDraft(); renderSection();
  });
  $('scr-section').querySelectorAll('[data-qdel]').forEach((b) => b.onclick = async () => {
    if (!confirm('Delete this question?')) return;
    s.questions.splice(Number(b.dataset.qdel), 1); await saveDraft(); renderSection();
  });
  $('s-back').onclick = () => { renderBuilder(); show('builder'); };
}

/* ── Builder: question ───────────────────────────────────────────── */
function renderQuestion() {
  const d = State.draft, s = d.sections[State.sectionIdx], q = s.questions[State.questionIdx];
  // Only questions that come earlier can drive conditional visibility,
  // otherwise a rule could depend on an answer that has not been given yet.
  const earlier = [];
  for (let si = 0; si <= State.sectionIdx; si++) {
    d.sections[si].questions.forEach((oq, qi) => {
      if (si < State.sectionIdx || qi < State.questionIdx) earlier.push(oq);
    });
  }
  const condSource = earlier.find((x) => x.id === (q.showIf && q.showIf.q));

  $('scr-question').innerHTML = `
    <div><p class="eyebrow">Question ${State.questionIdx + 1} · ${esc(s.title)}</p>
      <h2 style="margin-top:4px">Edit question</h2></div>

    <div class="card">
      <div class="q"><label class="lbl" for="q-label">Question wording</label>
        <textarea id="q-label" style="min-height:70px">${esc(q.label)}</textarea></div>
      <div class="q"><label class="lbl" for="q-hint">Hint below the question</label>
        <input id="q-hint" type="text" value="${esc(q.hint || '')}" placeholder="Optional" /></div>
      <label class="opt${q.required ? ' sel' : ''}">
        <input type="checkbox" id="q-req" ${q.required ? 'checked' : ''} />
        <span>Required — the interviewer cannot continue without it</span></label>
    </div>

    <div class="card">
      <p class="eyebrow">Answer type</p>
      <div class="typegrid">
        ${QTYPES.map((t) => `
          <button class="typebtn${q.type === t.t ? ' sel' : ''}" data-type="${t.t}">
            <strong>${esc(t.name)}</strong><span>${esc(t.desc)}</span></button>`).join('')}
      </div>
    </div>

    ${hasOptions(q.type) ? `
    <div class="card">
      <p class="eyebrow">Options</p>
      <div class="list" id="q-opts">
        ${(q.options || []).map((o, i) => `
          <div class="optedit">
            <input type="text" data-opt="${i}" value="${esc(o)}" />
            <button class="iconbtn del" data-optdel="${i}" aria-label="Remove option">✕</button>
          </div>`).join('')}
      </div>
      <button class="btn ghost sm" id="q-addopt">Add option</button>
      ${q.type === 'select_multi' ? `
        <div class="q"><label class="lbl" for="q-maxsel">Maximum selections</label>
          <p class="hint">Leave empty for no limit.</p>
          <input id="q-maxsel" type="number" min="1" value="${q.maxSelections || ''}" /></div>` : ''}
    </div>` : ''}

    ${q.type === 'matrix' ? `
    <div class="card">
      <p class="eyebrow">Rows</p>
      <div class="list">
        ${(q.rows || []).map((r, i) => `
          <div class="optedit">
            <input type="text" data-row="${i}" value="${esc(r)}" />
            <button class="iconbtn del" data-rowdel="${i}" aria-label="Remove row">✕</button>
          </div>`).join('')}
      </div>
      <button class="btn ghost sm" id="q-addrow">Add row</button>
    </div>` : ''}

    ${hasOptions(q.type) && q.type !== 'ranking' ? `
    <div class="card">
      <label class="opt${q.randomize ? ' sel' : ''}">
        <input type="checkbox" id="q-rand" ${q.randomize ? 'checked' : ''} />
        <span>Randomise the option order for each response — reduces order bias</span></label>
    </div>` : ''}

    ${q.type === 'text' ? `
    <div class="card">
      <p class="eyebrow">Format</p>
      <div class="q"><label class="lbl" for="q-mask">Input mask</label>
        <p class="hint">A = a letter, 0 = a digit. Anything else is literal. Example: AAA-000</p>
        <input id="q-mask" type="text" value="${esc(q.mask || '')}" placeholder="Leave empty for free text" /></div>
      <div class="q"><label class="lbl" for="q-ph">Example answer</label>
        <input id="q-ph" type="text" value="${esc(q.placeholder || '')}" /></div>
    </div>` : ''}

    ${q.type === 'textarea' ? `
    <div class="card"><div class="q"><label class="lbl" for="q-maxlen">Character limit</label>
      <input id="q-maxlen" type="number" min="10" value="${q.maxLength || 600}" /></div></div>` : ''}

    ${(q.type === 'integer' || q.type === 'number' || q.type === 'scale') ? `
    <div class="card">
      <p class="eyebrow">${q.type === 'scale' ? 'Scale range' : 'Allowed range'}</p>
      <div class="q"><label class="lbl" for="q-min">Lowest</label>
        <input id="q-min" type="number" value="${q.min ?? ''}" /></div>
      <div class="q"><label class="lbl" for="q-max">Highest</label>
        <input id="q-max" type="number" value="${q.max ?? ''}" /></div>
      ${q.type === 'scale' ? `
      <div class="q"><label class="lbl" for="q-minlab">Label at the low end</label>
        <input id="q-minlab" type="text" value="${esc(q.minLabel || '')}" /></div>
      <div class="q"><label class="lbl" for="q-maxlab">Label at the high end</label>
        <input id="q-maxlab" type="text" value="${esc(q.maxLabel || '')}" /></div>` : ''}
      ${(q.type === 'integer' || q.type === 'number') ? `
      <div class="q"><label class="lbl" for="q-atmost">Cannot exceed an earlier answer</label>
        <p class="hint">For example, children in the household cannot exceed household size.</p>
        <select id="q-atmost">
          <option value="">— no limit —</option>
          ${earlier.filter((x) => x.type === 'integer' || x.type === 'number').map((x) =>
            `<option value="${x.id}"${q.atMostField && q.atMostField.field === x.id ? ' selected' : ''}>${esc(x.label || x.id)}</option>`).join('')}
        </select></div>` : ''}
    </div>` : ''}

    <div class="card">
      <p class="eyebrow">Conditional logic</p>
      <p class="muted" style="font-size:.86rem">Show this question only when an earlier answer matches.</p>
      ${earlier.length === 0 ? '<p class="muted">Nothing comes before this question yet.</p>' : `
      <div class="q"><label class="lbl" for="c-q">Depends on</label>
        <select id="c-q">
          <option value="">— always show —</option>
          ${earlier.map((x) => `<option value="${x.id}"${q.showIf && q.showIf.q === x.id ? ' selected' : ''}>${esc(x.label || x.id)}</option>`).join('')}
        </select></div>
      ${q.showIf && q.showIf.q ? `
      <div class="q"><label class="lbl" for="c-op">Condition</label>
        <select id="c-op">
          <option value="eq"${q.showIf.eq !== undefined ? ' selected' : ''}>is exactly</option>
          <option value="notEq"${q.showIf.notEq !== undefined ? ' selected' : ''}>is anything except</option>
          <option value="in"${q.showIf.in !== undefined ? ' selected' : ''}>is one of</option>
        </select></div>
      <div class="q"><label class="lbl">Value</label>
        ${condSource && hasOptions(condSource.type) ? `
          <div class="opts">${(condSource.options || []).map((o) => {
            const cur = q.showIf.in !== undefined ? (q.showIf.in || []) : [q.showIf.eq ?? q.showIf.notEq];
            const on = cur.includes(o);
            return `<label class="opt${on ? ' sel' : ''}">
              <input type="${q.showIf.in !== undefined ? 'checkbox' : 'radio'}" name="condval" data-condval="${esc(o)}" ${on ? 'checked' : ''} />
              <span>${esc(o)}</span></label>`; }).join('')}</div>`
          : `<input id="c-val" type="text" value="${esc(q.showIf.eq ?? q.showIf.notEq ?? '')}" />`}
      </div>` : ''}`}
    </div>`;

  setActions('<button class="btn ghost wide" id="q-back">Back to section</button>');

  const save = async () => { await saveDraft(); };
  $('q-label').addEventListener('input', async (e) => { q.label = e.target.value; await save(); });
  $('q-hint').addEventListener('input', async (e) => { q.hint = e.target.value; await save(); });
  $('q-req').onchange = async (e) => {
    q.required = e.target.checked;
    e.target.closest('.opt').classList.toggle('sel', e.target.checked); await save();
  };
  $('scr-question').querySelectorAll('[data-type]').forEach((b) => b.onclick = async () => {
    const t = b.dataset.type;
    if (t === q.type) return;
    q.type = t;
    // Switching type must leave the question usable, not half-configured.
    if (hasOptions(t) && !q.options) q.options = ['Option 1', 'Option 2'];
    if (t === 'scale' || t === 'matrix') { q.min = q.min ?? 1; q.max = q.max ?? 5; }
    if (t === 'matrix' && !q.rows) q.rows = ['Row 1', 'Row 2'];
    await save(); renderQuestion();
  });
  const num = (id, key) => { const el = $(id); if (el) el.addEventListener('input', async (e) => {
    q[key] = e.target.value === '' ? undefined : Number(e.target.value); await save(); }); };
  const txt = (id, key) => { const el = $(id); if (el) el.addEventListener('input', async (e) => {
    q[key] = e.target.value || undefined; await save(); }); };
  num('q-min', 'min'); num('q-max', 'max'); num('q-maxlen', 'maxLength'); num('q-maxsel', 'maxSelections');
  txt('q-mask', 'mask'); txt('q-ph', 'placeholder'); txt('q-minlab', 'minLabel'); txt('q-maxlab', 'maxLabel');

  $('scr-question').querySelectorAll('[data-opt]').forEach((el) => el.addEventListener('input', async (e) => {
    q.options[Number(el.dataset.opt)] = e.target.value; await save();
  }));
  $('scr-question').querySelectorAll('[data-optdel]').forEach((b) => b.onclick = async () => {
    q.options.splice(Number(b.dataset.optdel), 1); await save(); renderQuestion();
  });
  $('scr-question').querySelectorAll('[data-row]').forEach((el) => el.addEventListener('input', async (e) => {
    q.rows[Number(el.dataset.row)] = e.target.value; await save();
  }));
  $('scr-question').querySelectorAll('[data-rowdel]').forEach((b) => b.onclick = async () => {
    q.rows.splice(Number(b.dataset.rowdel), 1); await save(); renderQuestion();
  });
  if ($('q-addrow')) $('q-addrow').onclick = async () => {
    q.rows.push(`Row ${q.rows.length + 1}`); await save(); renderQuestion();
  };
  if ($('q-rand')) $('q-rand').onchange = async (e) => {
    q.randomize = e.target.checked || undefined;
    e.target.closest('.opt').classList.toggle('sel', e.target.checked); await save();
  };
  if ($('q-addopt')) $('q-addopt').onclick = async () => {
    q.options.push(`Option ${q.options.length + 1}`); await save(); renderQuestion();
  };
  if ($('q-atmost')) $('q-atmost').onchange = async (e) => {
    q.atMostField = e.target.value ? { field: e.target.value, message: 'Cannot exceed the earlier answer.' } : undefined;
    await save();
  };
  if ($('c-q')) $('c-q').onchange = async (e) => {
    q.showIf = e.target.value ? { q: e.target.value, eq: '' } : undefined;
    await save(); renderQuestion();
  };
  if ($('c-op')) $('c-op').onchange = async (e) => {
    const src = q.showIf.q;
    q.showIf = e.target.value === 'in' ? { q: src, in: [] } : { q: src, [e.target.value]: '' };
    await save(); renderQuestion();
  };
  if ($('c-val')) $('c-val').addEventListener('input', async (e) => {
    if (q.showIf.eq !== undefined) q.showIf.eq = e.target.value; else q.showIf.notEq = e.target.value;
    await save();
  });
  $('scr-question').querySelectorAll('[data-condval]').forEach((el) => el.onchange = async () => {
    const val = el.dataset.condval;
    if (q.showIf.in !== undefined) {
      const arr = q.showIf.in || [];
      const at = arr.indexOf(val);
      if (el.checked && at === -1) arr.push(val);
      if (!el.checked && at > -1) arr.splice(at, 1);
      q.showIf.in = arr;
    } else if (q.showIf.eq !== undefined) q.showIf.eq = val;
    else q.showIf.notEq = val;
    await save(); renderQuestion();
  });
  $('q-back').onclick = () => { renderSection(); show('section'); };
}

/* ── Collection and preview ──────────────────────────────────────── */
function startInterview(instrumentId) {
  State.instrument = State.instruments.find((i) => i.id === instrumentId);
  State.preview = false;
  State.answers = {}; State.section = 0; State.shuffled = {};
  State.submissionId = uuidv7(); State.baseVersion = null;
  renderForm(); show('form');
}
function startPreview(instrumentId) {
  State.instrument = State.instruments.find((i) => i.id === instrumentId) || State.draft;
  State.preview = true;
  State.answers = {}; State.section = 0; State.shuffled = {};
  renderForm(); show('form');
  toast('Preview — nothing is saved');
}

function questionHTML(q, answers, err) {
  const v = answers[q.id];
  const req = q.required ? '<span class="req" aria-hidden="true">*</span>' : '';
  const hint = q.hint ? `<p class="hint">${esc(q.hint)}</p>` : '';
  const errHTML = err ? `<p class="err" id="err-${q.id}">${esc(err)}</p>` : '';
  const cls = `q${err ? ' invalid' : ''}`;
  const aria = err ? `aria-invalid="true" aria-describedby="err-${q.id}"` : '';
  let control = '';
  switch (q.type) {
    case 'text':
      control = `<input type="text" id="f-${q.id}" data-q="${q.id}" ${aria} value="${v ? esc(v) : ''}"
        placeholder="${esc(q.placeholder || '')}" ${q.mask ? `maxlength="${q.mask.length}"` : ''} autocomplete="off" />`;
      break;
    case 'textarea':
      control = `<textarea id="f-${q.id}" data-q="${q.id}" ${aria} maxlength="${q.maxLength || 2000}">${v ? esc(v) : ''}</textarea>
        <p class="counter"><span id="count-${q.id}">${(v || '').length}</span> / ${q.maxLength || 2000}</p>`;
      break;
    case 'integer': case 'number':
      control = `<input type="number" id="f-${q.id}" data-q="${q.id}" ${aria} inputmode="numeric" value="${v ?? ''}"
        ${q.min != null ? `min="${q.min}"` : ''} ${q.max != null ? `max="${q.max}"` : ''} ${q.type === 'integer' ? 'step="1"' : ''} />`;
      break;
    case 'date':
      control = `<input type="date" id="f-${q.id}" data-q="${q.id}" ${aria} value="${v ? esc(v) : ''}" />`;
      break;
    case 'dropdown':
      control = `<select id="f-${q.id}" data-q="${q.id}" ${aria}>
        <option value="">— choose —</option>
        ${optionsFor(q).map((o) => `<option value="${esc(o)}"${v === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}
      </select>`;
      break;
    case 'yesno':
      control = `<div class="opts" role="radiogroup" aria-label="${esc(q.label)}">` + ['Yes', 'No'].map((o) => `
        <label class="opt${v === o ? ' sel' : ''}"><input type="radio" name="${q.id}" data-q="${q.id}" value="${o}" ${v === o ? 'checked' : ''} />
        <span>${o}</span></label>`).join('') + '</div>';
      break;
    case 'matrix': {
      const cur = v || {};
      control = '<div>' + (q.rows || []).map((r) => {
        const btns = [];
        for (let n = q.min; n <= q.max; n++) {
          btns.push(`<button type="button" class="scale-btn${Number(cur[r]) === n ? ' sel' : ''}"
            data-mrow="${esc(r)}" data-q="${q.id}" data-val="${n}" aria-pressed="${Number(cur[r]) === n}">${n}</button>`);
        }
        return `<div class="matrixrow"><span>${esc(r)}</span><div class="scale-row">${btns.join('')}</div></div>`;
      }).join('') + `<div class="scale-ends" style="padding-top:8px"><span>${esc(q.minLabel || '')}</span><span>${esc(q.maxLabel || '')}</span></div></div>`;
      break;
    }
    case 'ranking': {
      const order = Array.isArray(v) && v.length === (q.options || []).length ? v : optionsFor(q);
      control = '<div class="list">' + order.map((o, i) => `
        <div class="rankitem">
          <span class="pos">${i + 1}</span>
          <span style="font-size:.9rem">${esc(o)}</span>
          <span class="ctrls">
            <button type="button" class="iconbtn" data-rank="${q.id}" data-dir="-1" data-idx="${i}"${i === 0 ? ' disabled' : ''} aria-label="Move up">↑</button>
            <button type="button" class="iconbtn" data-rank="${q.id}" data-dir="1" data-idx="${i}"${i === order.length - 1 ? ' disabled' : ''} aria-label="Move down">↓</button>
          </span>
        </div>`).join('') + '</div>';
      break;
    }
    case 'select_one':
      control = `<div class="opts" role="radiogroup" aria-label="${esc(q.label)}">` + optionsFor(q).map((o) => `
        <label class="opt${v === o ? ' sel' : ''}"><input type="radio" name="${q.id}" data-q="${q.id}" value="${esc(o)}" ${v === o ? 'checked' : ''} />
        <span>${esc(o)}</span></label>`).join('') + '</div>';
      break;
    case 'select_multi': {
      const arr = Array.isArray(v) ? v : [];
      control = `<div class="opts" role="group" aria-label="${esc(q.label)}">` + optionsFor(q).map((o) => `
        <label class="opt${arr.includes(o) ? ' sel' : ''}"><input type="checkbox" data-q="${q.id}" value="${esc(o)}" ${arr.includes(o) ? 'checked' : ''} />
        <span>${esc(o)}</span></label>`).join('') + '</div>';
      break;
    }
    case 'scale': {
      const btns = [];
      for (let n = q.min; n <= q.max; n++) {
        btns.push(`<button type="button" class="scale-btn${Number(v) === n ? ' sel' : ''}" data-q="${q.id}" data-val="${n}" aria-pressed="${Number(v) === n}">${n}</button>`);
      }
      control = `<div class="scale"><div class="scale-row">${btns.join('')}</div>
        <div class="scale-ends"><span>${esc(q.minLabel || '')}</span><span>${esc(q.maxLabel || '')}</span></div></div>`;
      break;
    }
    case 'checkbox':
      return `<div class="${cls}"><label class="opt${v ? ' sel' : ''}">
        <input type="checkbox" data-q="${q.id}" data-single="1" ${v ? 'checked' : ''} />
        <span>${esc(q.label)}${req}</span></label>${hint}${errHTML}</div>`;
    case 'geopoint':
      control = `<div class="row"><button type="button" class="btn ghost sm" data-geo="${q.id}">Capture location</button>
        <span class="muted mono" id="geo-${q.id}">${v ? esc(`${v.lat.toFixed(5)}, ${v.lon.toFixed(5)} ±${Math.round(v.acc)}m`) : 'Not captured'}</span></div>`;
      break;
    default: control = `<p class="muted">Unsupported type: ${esc(q.type)}</p>`;
  }
  return `<div class="${cls}"><label class="lbl" for="f-${q.id}">${esc(q.label)}${req}</label>${hint}${control}${errHTML}</div>`;
}

function renderForm(errs = {}) {
  const i = State.instrument, s = i.sections[State.section];
  const vis = s.questions.filter((q) => visible(q, State.answers));
  vis.forEach((q) => {
    if (q.type === 'ranking' && !Array.isArray(State.answers[q.id])) State.answers[q.id] = [...optionsFor(q)];
  });
  const pct = Math.round((State.section / i.sections.length) * 100);
  $('scr-form').innerHTML = `
    ${State.preview ? `<div class="previewbanner"><span><b>Preview</b> — exactly what the interviewer sees</span><span>${esc(i.code || '')}</span></div>` : ''}
    <div class="progress"><div class="bar"><i style="width:${pct}%"></i></div>
      <div class="steps"><span>Section ${State.section + 1} of ${i.sections.length}</span><span>${esc(s.title)}</span></div></div>
    <div class="card">
      <p class="eyebrow">${esc(s.note || i.code || '')}</p>
      <h2>${esc(s.title)}</h2>
      <div>${vis.length ? vis.map((q) => questionHTML(q, State.answers, errs[q.id])).join('')
        : '<p class="muted">No questions are visible here with the current answers.</p>'}</div>
    </div>
    ${Object.keys(errs).length ? `<div class="notice risk"><b>${Object.keys(errs).length} answer${Object.keys(errs).length > 1 ? 's need' : ' needs'} attention</b><span>Corrections are marked above.</span></div>` : ''}`;
  setActions(`
    <button class="btn ghost" id="f-back">${State.section === 0 ? (State.preview ? 'Close' : 'Cancel') : 'Back'}</button>
    <button class="btn" id="f-next">${State.section === i.sections.length - 1 ? (State.preview ? 'Finish preview' : 'Save response') : 'Continue'}</button>`);
  wireForm();
  $('f-back').onclick = async () => {
    if (State.section === 0) {
      if (State.preview && State.draft) { renderBuilder(); show('builder'); return; }
      await renderHome(); show('home'); return;
    }
    State.section--; renderForm();
  };
  $('f-next').onclick = onNext;
}

function wireForm() {
  const root = $('scr-form');
  root.querySelectorAll('input[type=text], input[type=number], input[type=date], textarea').forEach((el) => {
    el.addEventListener('input', () => {
      const q = el.dataset.q;
      State.answers[q] = el.type === 'number' ? (el.value === '' ? undefined : Number(el.value)) : el.value;
      const c = $(`count-${q}`); if (c) c.textContent = el.value.length;
      el.closest('.q').classList.remove('invalid');
    });
  });
  root.querySelectorAll('input[type=radio]').forEach((el) => el.addEventListener('change', () => {
    State.answers[el.dataset.q] = el.value; renderForm();
  }));
  root.querySelectorAll('select[data-q]').forEach((el) => el.addEventListener('change', () => {
    State.answers[el.dataset.q] = el.value || undefined; renderForm();
  }));
  root.querySelectorAll('[data-mrow]').forEach((el) => el.addEventListener('click', () => {
    const q = el.dataset.q, row = el.dataset.mrow;
    const cur = { ...(State.answers[q] || {}) };
    cur[row] = Number(el.dataset.val);
    State.answers[q] = cur;
    el.parentElement.querySelectorAll('.scale-btn').forEach((b) => {
      const on = b === el; b.classList.toggle('sel', on); b.setAttribute('aria-pressed', on);
    });
    el.closest('.q').classList.remove('invalid');
  }));
  root.querySelectorAll('[data-rank]').forEach((el) => el.addEventListener('click', () => {
    const qid = el.dataset.rank;
    const q = allQuestions(State.instrument).find((x) => x.id === qid);
    const order = Array.isArray(State.answers[qid]) && State.answers[qid].length === (q.options || []).length
      ? [...State.answers[qid]] : [...optionsFor(q)];
    move(order, Number(el.dataset.idx), Number(el.dataset.dir));
    State.answers[qid] = order;
    renderForm();
  }));
  root.querySelectorAll('input[type=checkbox]').forEach((el) => el.addEventListener('change', () => {
    const q = el.dataset.q;
    if (el.dataset.single) State.answers[q] = el.checked;
    else {
      const arr = Array.isArray(State.answers[q]) ? [...State.answers[q]] : [];
      const at = arr.indexOf(el.value);
      if (el.checked && at === -1) arr.push(el.value);
      if (!el.checked && at > -1) arr.splice(at, 1);
      State.answers[q] = arr;
    }
    el.closest('.opt').classList.toggle('sel', el.checked);
  }));
  root.querySelectorAll('.scale-btn:not([data-mrow])').forEach((el) => el.addEventListener('click', () => {
    State.answers[el.dataset.q] = Number(el.dataset.val);
    el.parentElement.querySelectorAll('.scale-btn').forEach((b) => {
      const on = b === el; b.classList.toggle('sel', on); b.setAttribute('aria-pressed', on);
    });
  }));
  root.querySelectorAll('[data-geo]').forEach((el) => el.addEventListener('click', () => {
    const q = el.dataset.geo;
    if (!navigator.geolocation) { toast('This device has no location service'); return; }
    el.disabled = true; el.textContent = 'Capturing…';
    navigator.geolocation.getCurrentPosition((pos) => {
      State.answers[q] = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy };
      $(`geo-${q}`).textContent = `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)} ±${Math.round(pos.coords.accuracy)}m`;
      el.disabled = false; el.textContent = 'Recapture';
    }, () => { toast('Location unavailable — continuing without it'); el.disabled = false; el.textContent = 'Capture location'; },
      { enableHighAccuracy: true, timeout: 8000 });
  }));
}

async function onNext() {
  const i = State.instrument, s = i.sections[State.section];
  const errs = validateSection(s, State.answers);
  if (Object.keys(errs).length) {
    renderForm(errs);
    const first = $('scr-form').querySelector('.q.invalid');
    if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  if (State.section < i.sections.length - 1) { State.section++; renderForm(); return; }
  if (State.preview) {
    toast('Preview complete — nothing was saved');
    if (State.draft) { renderBuilder(); show('builder'); } else { await renderHome(); show('home'); }
    return;
  }
  await saveRecord();
}

async function saveRecord() {
  const answers = pruneHidden(State.answers, State.instrument);
  const version = (State.baseVersion || 0) + 1;
  const env = await buildEnvelope(answers, State.submissionId, version, State.baseVersion);
  await DB.put('events', { ...env, synced: false, conflict: false });
  await DB.put('outbox', env);
  await audit('response.save', `${State.submissionId} v${version}`);
  toast('Saved on this device');
  if (navigator.onLine) {
    const r = await syncOutbox();
    if (r.sent) toast(`Saved and transmitted${r.conflicts ? ' — conflict flagged' : ''}`);
  }
  await renderHome(); show('home');
}

/* ── Responses ───────────────────────────────────────────────────── */
async function renderQueue() {
  const subs = await submissions();
  const outbox = await DB.all('outbox');
  $('scr-queue').innerHTML = `
    <div><p class="eyebrow">Responses</p>
      <h2 style="margin-top:4px">${subs.length} on this device</h2>
      <p class="muted" style="margin-top:6px">${outbox.length} waiting to transmit. A response leaves the outbox only after the server confirms a durable write.</p></div>
    ${subs.length === 0 ? '<div class="notice"><b>Nothing collected yet</b><span>Completed interviews appear here.</span></div>' : ''}
    <div class="list">
      ${subs.map((s) => `
        <button class="item ${s.conflict ? 'conflict' : s.synced ? 'synced' : 'pending'}" data-sub="${s.id}">
          <div class="item-top"><strong>${esc(s.label)}</strong>
            <span class="tag ${s.conflict ? 'conflict' : s.synced ? 'synced' : 'pending'}">${s.conflict ? 'Conflict' : s.synced ? 'Synced' : 'Pending'}</span></div>
          <span class="muted" style="font-size:.82rem">${esc(s.instrumentTitle)}</span>
          <span class="muted mono">v${s.version} · ${s.events.length} event${s.events.length > 1 ? 's' : ''} · ${new Date(s.capturedAt).toLocaleString()}</span>
        </button>`).join('')}
    </div>`;
  setActions(`<button class="btn ghost" id="q-back">Back</button>
    <button class="btn" id="q-sync"${outbox.length ? '' : ' disabled'}>Transmit ${outbox.length || ''}</button>`);
  $('q-back').onclick = async () => { await renderHome(); show('home'); };
  $('q-sync').onclick = async () => {
    $('q-sync').disabled = true; $('q-sync').textContent = 'Transmitting…';
    const r = await syncOutbox();
    toast(`${r.sent} sent · ${r.dupes} duplicate${r.dupes === 1 ? '' : 's'} ignored${r.conflicts ? ` · ${r.conflicts} conflict` : ''}`);
    await renderQueue();
  };
  $('scr-queue').querySelectorAll('[data-sub]').forEach((b) => b.onclick = async () => {
    await renderRecord(b.dataset.sub); show('record');
  });
}

async function renderRecord(id) {
  const subs = await submissions();
  const s = subs.find((x) => x.id === id);
  if (!s) { await renderQueue(); show('queue'); return; }
  const answers = await Crypto.decrypt(s.latest.payload);
  $('scr-record').innerHTML = `
    <div><p class="eyebrow">Response</p><h2 style="margin-top:4px">${esc(s.label)}</h2>
      <p class="muted" style="font-size:.84rem">${esc(s.instrumentTitle)}</p>
      <p class="muted mono">${esc(s.id)}</p></div>
    ${s.conflict ? `<div class="notice risk"><b>Two versions share a parent</b>
      <span>Both were stored. Nothing was discarded and nothing was chosen automatically.</span></div>` : ''}
    <div class="card"><h3>Event history</h3>
      <p class="muted">Append-only. A correction adds a version; it never overwrites one.</p>
      <div class="list">
        ${s.events.map((e) => `<div class="item ${e.synced ? 'synced' : 'pending'}" style="cursor:default">
          <div class="item-top"><strong>Version ${e.version}</strong>
            <span class="tag ${e.synced ? 'synced' : 'pending'}">${e.synced ? 'seq ' + e.server_seq : 'Pending'}</span></div>
          <span class="muted mono">op ${esc(e.op_id.slice(0, 18))}… · parent ${e.parent_version ?? '—'}</span></div>`).join('')}
      </div></div>
    <div class="card"><h3>Answers</h3><p class="muted">Decrypted in memory for display only.</p>
      <pre class="dump">${esc(JSON.stringify(answers, null, 2))}</pre></div>`;
  setActions('<button class="btn ghost" id="r-back">Back</button><button class="btn" id="r-edit">Add correction</button>');
  $('r-back').onclick = async () => { await renderQueue(); show('queue'); };
  $('r-edit').onclick = () => {
    State.instrument = State.instruments.find((i) => i.id === s.latest.instrument_id);
    if (!State.instrument) { toast('That survey was deleted from this device'); return; }
    State.preview = false;
    State.answers = answers; State.submissionId = s.id; State.baseVersion = s.version; State.section = 0;
    renderForm(); show('form');
    toast(`Editing — this becomes version ${s.version + 1}`);
  };
}

/* ── About ───────────────────────────────────────────────────────── */
async function renderAbout() {
  const log = (await DB.all('audit')).sort((a, b) => b.id.localeCompare(a.id)).slice(0, 12);
  $('scr-about').innerHTML = `
    <div><p class="eyebrow">About this build</p><h2 style="margin-top:4px">What it does, and what it is not</h2></div>
    <div class="notice risk"><b>Not a HIPAA-compliant system</b>
      <span>No business associate agreements are in place and no server-side controls exist. Do not enter names, addresses, phone numbers, dates of birth, record numbers, or any other identifying information.</span></div>
    <div class="card"><h3>What is real</h3>
      <ul style="margin:0;padding-left:20px;display:grid;gap:6px" class="muted">
        <li>Anyone can build a survey here — sections, ten question types, validation rules and conditional logic</li>
        <li>Preview shows exactly what the interviewer will see</li>
        <li>Surveys export and import as JSON, so they move between devices</li>
        <li>Works with no connectivity; every asset is cached on first load</li>
        <li>Responses encrypted on the device with AES-256-GCM, key derived from your passphrase and never stored</li>
        <li>Each operation carries a UUIDv7 idempotency key and an HMAC signature</li>
        <li>Append-only history: corrections add versions, nothing is overwritten</li>
        <li>Divergent edits are flagged for a human, never resolved automatically</li>
      </ul></div>
    <div class="card"><h3>What is simulated</h3>
      <p class="muted">The server is a local store, so the protocol can be demonstrated end to end without a backend. Swapping it for a real API is one function, <span class="mono">transmit</span>.</p></div>
    <div class="card"><h3>This device</h3>
      <p class="muted mono">device ${esc(State.deviceId || '—')}<br />user ${esc(State.collector || '—')}</p>
      <h3 style="margin-top:8px">Recent activity</h3>
      <div class="list">${log.map((a) => `<div class="item" style="cursor:default;border-left-color:var(--g-300)">
        <div class="item-top"><strong>${esc(a.action)}</strong><span class="muted mono">${new Date(a.at).toLocaleTimeString()}</span></div>
        ${a.detail ? `<span class="muted mono">${esc(a.detail)}</span>` : ''}</div>`).join('')}</div></div>
    <div class="card"><h3>Danger zone</h3>
      <p class="muted">Erasing destroys the local key, every survey and every response on this device.</p>
      <button class="btn danger wide" id="a-wipe">Erase this device</button></div>`;
  setActions('<button class="btn ghost wide" id="a-back">Back</button>');
  $('a-back').onclick = async () => { await renderHome(); show('home'); };
  $('a-wipe').onclick = async () => {
    if (!confirm('Erase all surveys, responses and the encryption key? This cannot be undone.')) return;
    indexedDB.deleteDatabase('epi-collect'); Crypto.lock();
    setTimeout(() => location.reload(), 300);
  };
}

/* ── Boot ────────────────────────────────────────────────────────── */
async function boot() {
  netStatus();
  window.addEventListener('online', () => { netStatus(); toast('Back online'); });
  window.addEventListener('offline', () => { netStatus(); toast('Offline — capture continues'); });
  await DB.open();
  await loadIdentity();
  State.instruments = await DB.all('instruments');
  await renderUnlock();
  show('unlock');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
document.addEventListener('DOMContentLoaded', boot);
