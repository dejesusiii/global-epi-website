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
/* Stores whose rows belong to exactly one client workspace. */
const SCOPED = ['events', 'outbox', 'audit', 'instruments', 'server'];
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

  /* Everything a client owns is stamped with its workspace id, and every
     read is filtered by the open one. Putting that here rather than at
     each call site is deliberate: an isolation rule that depends on
     thirty callers remembering a filter is not a rule, it is a hope.
     With no workspace open these stores read empty — fail closed. */
  allRaw(s) { return this.req(this.tx(s).getAll()); },
  putRaw(s, v) { return this.req(this.tx(s, 'readwrite').put(v)); },
  async all(s) {
    const rows = await this.allRaw(s);
    if (!SCOPED.includes(s)) return rows;
    const ws = State.ws && State.ws.id;
    return ws ? rows.filter((r) => r.ws === ws) : [];
  },
  async get(s, k) {
    const r = await this.req(this.tx(s).get(k));
    if (!r || !SCOPED.includes(s)) return r;
    return State.ws && r.ws === State.ws.id ? r : undefined;
  },
  put(s, v) {
    const val = SCOPED.includes(s) && State.ws ? { ...v, ws: State.ws.id } : v;
    return this.req(this.tx(s, 'readwrite').put(val));
  },
  async del(s, k) {
    if (SCOPED.includes(s)) {
      const cur = await this.req(this.tx(s).get(k));
      if (cur && (!State.ws || cur.ws !== State.ws.id)) return;   // not this client's to delete
    }
    return this.req(this.tx(s, 'readwrite').delete(k));
  },
  async meta(k, v) {
    if (v === undefined) { const r = await this.get('meta', k); return r ? r.v : null; }
    return this.put('meta', { k, v });
  },
};

/* ── Is there a server? ──────────────────────────────────────────
   No. transmit() writes to an object store in this same browser so the
   delivery protocol can be exercised end to end without a backend. That
   is useful for development and dishonest in the field: a collector who
   reads "Synced" concludes the response is off the phone and safe, and
   then trusts a device that is in fact the only copy. Every word the
   interface uses about delivery is driven from here, so the day
   transmit() posts to a real endpoint the wording becomes true in one
   edit rather than in fifteen. */
const SERVER_IS_REAL = false;

/* ── Durability ──────────────────────────────────────────────────
   IndexedDB survives closing the browser, but by default it is
   "best-effort": the browser may evict it under storage pressure, and
   iOS evicts a site that has not been opened in seven days unless it
   was installed to the home screen. Asking for persistent storage is
   what turns that from a maybe into a promise, so we ask — and report
   the answer instead of assuming it was granted. */
const Store = {
  persisted: null, usage: null, quota: null,
  async read() {
    try { this.persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null; }
    catch { this.persisted = null; }
    try {
      const e = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
      this.usage = e ? e.usage : null; this.quota = e ? e.quota : null;
    } catch { this.usage = this.quota = null; }
    return this.persisted;
  },
  async request() {
    if (!navigator.storage?.persist) { this.persisted = null; return null; }
    try { this.persisted = await navigator.storage.persist(); } catch { this.persisted = null; }
    await this.read();
    return this.persisted;
  },
};
const mb = (n) => (n === null || n === undefined ? '—' : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/* A failed unlock happens before a workspace is open, so the workspace
   being attempted is passed in — otherwise the one audit entry that
   matters most would be the one that goes nowhere. */
async function audit(action, detail, wsId) {
  await DB.putRaw('audit', { id: uuidv7(), ws: wsId || (State.ws && State.ws.id) || null,
    at: new Date().toISOString(), collector: State.collector, device: State.deviceId,
    action, detail: detail || '' });
}

/* ── Client workspaces ───────────────────────────────────────────
   One workspace per client. Each carries its own salt, so the key
   derived from its passphrase is a different key — Client A's
   passphrase does not decrypt Client B's records, and no filter is
   standing between them. Only the workspace list itself is device-wide,
   because something has to be readable before anything is unlocked. */
async function loadWorkspaces() {
  State.workspaces = (await DB.meta('workspaces')) || [];
  return State.workspaces;
}
const saveWorkspaces = () => DB.meta('workspaces', State.workspaces);

/* A device enrolled before workspaces existed keeps its passphrase and
   its data: the old salt and verifier become the first workspace, and
   every existing record is stamped with it. */
async function migrateToWorkspaces() {
  if (await DB.meta('workspaces')) return false;
  const salt = await DB.meta('salt');
  if (!salt) { await DB.meta('workspaces', []); return false; }
  const id = (await DB.meta('tenant_id')) || uuidv7();
  await DB.meta('workspaces', [{
    id, name: 'Default workspace', salt, verifier: await DB.meta('verifier'),
    collector: (await DB.meta('collector')) || 'GE-USER-01',
    created_at: new Date().toISOString(),
  }]);
  for (const store of SCOPED) {
    for (const r of await DB.allRaw(store)) {
      if (!r.ws) { r.ws = id; await DB.putRaw(store, r); }
    }
  }
  return true;
}

async function createWorkspace(name, pass, collector) {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const verifier = await Crypto.derive(pass, salt);
  Crypto.lock();                                   // derive left a key loaded; not open yet
  const ws = { id: uuidv7(), name, salt, verifier,
    collector: collector || 'GE-USER-01', created_at: new Date().toISOString() };
  State.workspaces.push(ws);
  await saveWorkspaces();
  return ws;
}

async function openWorkspace(ws, pass) {
  if (await Crypto.derive(pass, ws.salt) !== ws.verifier) { Crypto.lock(); return false; }
  State.ws = ws;
  State.tenantId = ws.id;                          // the tenant is the client, at last
  State.collector = ws.collector || 'GE-USER-01';
  State.deviceId = await DB.meta('device_id');
  await DB.meta('last_workspace', ws.id);
  await upgradeLegacyInstruments();
  State.instruments = await loadInstruments();
  return true;
}

function closeWorkspace() {
  Crypto.lock();
  State.ws = null; State.instruments = []; State.instrument = null;
  State.draft = null; State.share = null; State.pickedWs = null;
}

/* ── Instruments, encrypted like everything else ──────────────────
   A questionnaire is not neutral: its wording tells you what the
   engagement is about. Scoping it to a workspace stops it appearing in
   another client's library; encrypting it under that workspace's key is
   what makes the separation hold when someone reads the database
   directly. */
async function loadInstruments() {
  const out = [];
  for (const r of await DB.all('instruments')) {
    if (r.enc) {
      try { out.push({ ...(await Crypto.decrypt(r.enc)), id: r.id }); } catch { /* another client's key */ }
    } else if (Array.isArray(r.sections)) {
      out.push(r);                                 // written before instruments were encrypted
    }
  }
  return out;
}
const saveInstrument = async (inst) => DB.put('instruments', { id: inst.id, enc: await Crypto.encrypt(inst) });
async function upgradeLegacyInstruments() {
  for (const r of await DB.all('instruments')) {
    if (!r.enc && Array.isArray(r.sections)) await saveInstrument(r);
  }
}

/* ── State ───────────────────────────────────────────────────────── */
const State = {
  instruments: [], instrument: null,
  deviceId: null, tenantId: null, collector: null,
  ws: null, workspaces: [], pickedWs: null,
  answers: {}, section: 0, preview: false, shuffled: {}, analysisId: null, path: [],
  respond: false, share: null, lastResponse: null,
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
  { t: 'nps',          name: 'NPS',          desc: '0–10, scored the standard way' },
  { t: 'stars',        name: 'Stars',        desc: 'Tap a star rating' },
  { t: 'slider',       name: 'Slider',       desc: 'Drag along a range' },
  { t: 'constant_sum', name: 'Allocate',     desc: 'Split a fixed total across options' },
  { t: 'matrix',       name: 'Matrix',       desc: 'Several rows on one shared scale' },
  { t: 'ranking',      name: 'Ranking',      desc: 'Put the options in order' },
  { t: 'date',         name: 'Date',         desc: 'Calendar picker' },
  { t: 'checkbox',     name: 'Confirmation', desc: 'A single tick box' },
  { t: 'geopoint',     name: 'Location',     desc: 'Device coordinates' },
];
const typeName = (t) => (QTYPES.find((x) => x.t === t) || { name: t }).name;
const hasOptions = (t) => ['select_one', 'select_multi', 'dropdown', 'ranking', 'constant_sum'].includes(t);
const canOther = (t) => ['select_one', 'select_multi', 'dropdown'].includes(t);
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
    || (q.type === 'matrix' && Object.keys(v || {}).length === 0)
    || (q.type === 'constant_sum' && Object.keys(v || {}).length === 0);
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
  instrument.sections.forEach((s) => s.questions.forEach((q) => {
    if (visible(q, out)) return;
    delete out[q.id];
    delete out[otherKey(q)];   // the write-in goes with the answer it belonged to
  }));
  return out;
}
const allQuestions = (inst) => inst.sections.flatMap((s) => s.questions);

/* {{question_id}} inside wording is replaced by that answer, so a later
   question can quote an earlier one back to the respondent. */
function pipe(text, answers) {
  return String(text || '').replace(/\{\{\s*([\w-]+)\s*\}\}/g, (m, id) => {
    const v = answers[id];
    if (v === undefined || v === null || v === '') return '…';
    if (Array.isArray(v)) return v.join(', ');
    if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k}: ${x}`).join(', ');
    return String(v);
  });
}

/* A choice question can offer "Other", whose text lives in its own key so
   it exports as its own column instead of being buried in the choice. */
const OTHER = 'Other';
const otherKey = (q) => `${q.id}__other`;
function choicesFor(q) {
  const base = optionsFor(q);
  return q.allowOther ? [...base, OTHER] : base;
}

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

/* Where the next Continue leads. Jump rules are evaluated in order and the
   first match wins; -1 ends the survey early. Without rules this is simply
   the next section. */
function nextSectionIndex() {
  const i = State.instrument, s = i.sections[State.section];
  for (const j of (s.jumps || [])) {
    if (!j.q) continue;
    const a = State.answers[j.q];
    const hit = Array.isArray(a) ? a.includes(j.val) : String(a) === String(j.val);
    if (hit) {
      if (j.to === '__end') return -1;
      const idx = i.sections.findIndex((x) => x.id === j.to);
      if (idx > -1) return idx;
    }
  }
  return State.section + 1 < i.sections.length ? State.section + 1 : -1;
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

/* ── Sharing a survey by link ─────────────────────────────────────
   The whole questionnaire travels inside the URL fragment. A fragment
   is never sent to a server, so opening a link publishes nothing: the
   definition is decoded and run entirely in the respondent's browser.
   Answers are a separate problem — see submitPublic(). */
function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(str) {
  const t = str.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(t + '='.repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0));
}
async function gzip(bytes) {
  const cs = new CompressionStream('gzip');
  const w = cs.writable.getWriter(); w.write(bytes); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
async function gunzip(bytes) {
  const ds = new DecompressionStream('gzip');
  const w = ds.writable.getWriter(); w.write(bytes); w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}
/* Only what a respondent's browser needs to run the survey. Response
   counts, drafts and anything else on this device stay on this device. */
function shareable(inst) {
  return {
    id: inst.id, version: inst.version, code: inst.code || '', title: inst.title,
    subtitle: inst.subtitle || '', locale: inst.locale || 'en',
    estimatedMinutes: inst.estimatedMinutes || 5,
    endpoint: inst.endpoint || '', closing: inst.closing || '',
    sections: inst.sections,
  };
}
async function packSurvey(inst) {
  const raw = enc.encode(JSON.stringify(shareable(inst)));
  if (typeof CompressionStream === 'function') {
    try { return 'g' + b64url(await gzip(raw)); } catch { /* fall through */ }
  }
  return 'r' + b64url(raw);
}
async function unpackSurvey(code) {
  const body = unb64url(code.slice(1));
  const raw = code[0] === 'g' ? await gunzip(body) : body;
  const inst = JSON.parse(dec.decode(raw));
  if (!inst || !Array.isArray(inst.sections) || !inst.sections.length) throw new Error('shape');
  return inst;
}
async function surveyLink(inst) {
  const base = location.href.split('#')[0];
  return `${base}#s=${await packSurvey(inst)}`;
}

/* ── A response that arrives as a file ────────────────────────────
   Without a collection address a link cannot send answers back, so the
   respondent downloads one of these and the owner imports it here. */
const RESPONSE_KIND = 'epi-collect-response';
async function importResponse(obj) {
  if (!obj || obj.kind !== RESPONSE_KIND) return 'not a response file';
  const inst = State.instruments.find((i) => i.id === obj.survey_id)
    || State.instruments.find((i) => (i.code || '') && i.code === obj.survey_code);
  if (!inst) return 'no matching survey on this device';
  const subId = obj.response_id || uuidv7();
  const already = (await DB.all('events')).some((e) => e.submission_id === subId);
  if (already) return 'already imported';
  const payload = await Crypto.encrypt(obj.answers || {});
  const env = {
    op_id: uuidv7(), tenant_id: State.tenantId,
    instrument_id: inst.id, instrument_version: obj.survey_version || inst.version,
    submission_id: subId, version: 1, parent_version: null,
    device_id: State.deviceId, collector_id: State.collector, via: 'link',
    captured_at_device: obj.submitted_at || new Date().toISOString(), payload,
  };
  env.payload_hmac = await Crypto.sign(`${env.op_id}|${env.submission_id}|${env.version}|${env.payload.ct}`);
  await DB.put('events', { ...env, synced: false, conflict: false });
  await DB.put('outbox', env);
  await audit('response.import', subId);
  return null;
}

/* ── Backup of the whole device ──────────────────────────────────
   Storage that survives a browser close still does not survive a lost
   phone, a wiped profile, or "clear site data". A backup is the only
   thing that does. Response payloads are already AES-GCM ciphertext, so
   the file carries no readable answers; it also carries the salt and
   verifier, which are not secret, so the same passphrase opens it on a
   new device. The passphrase itself is in neither the file nor this
   app — without it the backup is inert. */
const BACKUP_KIND = 'epi-collect-backup';

async function buildBackup() {
  const w = State.ws;
  return {
    kind: BACKUP_KIND, v: 2,
    exported_at: new Date().toISOString(),
    workspace: { id: w.id, name: w.name, salt: w.salt, verifier: w.verifier, collector: w.collector,
                 created_at: w.created_at },
    device_id: await DB.meta('device_id'),
    /* Scoped reads, so a backup can only ever contain this client. */
    instruments: await DB.all('instruments'),
    events: await DB.all('events'),
    outbox: await DB.all('outbox'),
    audit: await DB.all('audit'),
  };
}

/* Merging a backup into a device holding ciphertext from a different
   passphrase would leave records nothing on that device can open, so
   that case is refused rather than half-completed. */
/* A backup belongs to one client. Restoring it re-creates that client's
   workspace if this device does not have it, and merges into it if it
   does — but only when the key material matches, because merging under
   a different key would leave records nothing here could ever open. */
async function restoreBackup(obj) {
  if (!obj || obj.kind !== BACKUP_KIND) return { error: 'That file is not a workspace backup.' };
  const w = obj.workspace;
  if (!w || !w.salt || !w.verifier || !w.id) {
    return { error: 'That backup is missing its key material and cannot be opened.' };
  }
  await loadWorkspaces();
  const existing = State.workspaces.find((x) => x.id === w.id)
    || State.workspaces.find((x) => x.name.toLowerCase() === String(w.name || '').toLowerCase());
  if (existing && existing.verifier !== w.verifier) {
    return { error: `This backup was made under a different passphrase than the “${existing.name}” workspace on this device. Restoring it would leave records nothing here could decrypt. Restore it onto a device that does not already hold this client.` };
  }
  let target = existing;
  if (!target) {
    target = { id: w.id, name: w.name || 'Restored workspace', salt: w.salt, verifier: w.verifier,
      collector: w.collector || 'GE-USER-01', created_at: w.created_at || new Date().toISOString() };
    State.workspaces.push(target);
    await saveWorkspaces();
  }
  if (!(await DB.meta('device_id'))) await DB.meta('device_id', obj.device_id || uuidv7());

  /* Rows are written raw and stamped with the target workspace, because
     restoring happens before that workspace is unlocked. */
  const stamp = (r) => ({ ...r, ws: target.id });
  const ours = (rows) => rows.filter((r) => r.ws === target.id);
  const counts = { instruments: 0, events: 0, outbox: 0 };
  const seenEvents = new Set(ours(await DB.allRaw('events')).map((e) => e.op_id));
  const seenInst = new Set(ours(await DB.allRaw('instruments')).map((i) => i.id));
  const seenOut = new Set(ours(await DB.allRaw('outbox')).map((e) => e.op_id));
  for (const i of obj.instruments || []) { if (!seenInst.has(i.id)) { await DB.putRaw('instruments', stamp(i)); counts.instruments++; } }
  for (const e of obj.events || []) { if (!seenEvents.has(e.op_id)) { await DB.putRaw('events', stamp(e)); counts.events++; } }
  for (const e of obj.outbox || []) { if (!seenOut.has(e.op_id)) { await DB.putRaw('outbox', stamp(e)); counts.outbox++; } }
  for (const a of obj.audit || []) { await DB.putRaw('audit', stamp(a)); }
  return { counts, id: target.id, name: target.name, created: !existing };
}

async function downloadBackup() {
  const backup = await buildBackup();
  const stamp = new Date().toISOString().slice(0, 10);
  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const slug = (State.ws.name || 'workspace').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  a.download = `epi-collect-${slug}-${stamp}.json`;
  a.click(); URL.revokeObjectURL(a.href);
  await DB.meta(`last_backup:${State.ws.id}`, { at: new Date().toISOString(), events: backup.events.length });
  await audit('device.backup', `${backup.events.length} events`);
  return backup;
}

/* How many stored responses are not in the most recent backup. */
async function unbackedUp() {
  const last = await DB.meta(`last_backup:${State.ws.id}`);
  const total = (await DB.all('events')).length;
  return { total, since: Math.max(0, total - (last ? last.events : 0)), at: last ? last.at : null };
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
  if (type === 'nps') { q.min = 0; q.max = 10; }
  if (type === 'stars') { q.max = 5; }
  if (type === 'slider') { q.min = 0; q.max = 100; q.step = 1; }
  if (type === 'constant_sum') { q.total = 100; }
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
      if (q.type === 'slider' && !(q.max > q.min)) p.push(`${where} needs a range where the top is above the bottom.`);
      if (q.type === 'constant_sum' && !(q.total > 0)) p.push(`${where} needs a total above zero.`);
    });
  });
  return p;
}

/* A collection address that cannot receive answers is worse than none:
   the respondent is told it was sent. Plain http is allowed only against
   a local machine, which is the one case where it is a test and not a
   leak. */
function endpointProblem(value) {
  const s = (value || '').trim();
  if (!s) return null;
  let url;
  try { url = new URL(s); } catch { return 'That is not a web address, so link answers would be lost rather than delivered.'; }
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null;
  return 'Answers have to be sent over https. Over plain http they travel in the clear, and this app served over https will refuse to send them at all.';
}

/* ── View helpers ────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
const SCREENS = ['unlock', 'home', 'form', 'queue', 'record', 'builder', 'section', 'question', 'preview', 'analysis', 'respond', 'done', 'about'];
function show(name) { SCREENS.forEach((s) => { $(`scr-${s}`).hidden = s !== name; }); window.scrollTo(0, 0); }
function setActions(html) { const b = $('actionbar'); b.innerHTML = html || ''; b.hidden = !html; }
function netStatus() {
  const on = navigator.onLine;
  $('netdot').classList.toggle('on', on);
  $('nettext').textContent = on ? 'Online' : 'Offline';
}
async function saveDraft() {
  State.draft.updatedAt = new Date().toISOString();
  await saveInstrument(State.draft);
  State.instruments = await loadInstruments();
  // A link carries a copy of the survey, so any edit makes the one on
  // screen stale. Drop it rather than let it be shared.
  if (State.share && State.share.id === State.draft.id) State.share = null;
}

/* ── Unlock ──────────────────────────────────────────────────────── */
async function renderUnlock() {
  await loadWorkspaces();
  const list = State.workspaces;
  const creating = State.pickedWs === '__new' || list.length === 0;
  const picked = creating ? null : list.find((w) => w.id === State.pickedWs);

  const scopeNote = `<div class="notice warn"><b>Pilot scope</b>
      <span>Non-identifying data only. This is not a HIPAA-compliant system.</span></div>`;

  if (creating) {
    $('scr-unlock').innerHTML = `
      <div class="card">
        <p class="eyebrow">${list.length ? 'New client workspace' : 'Set up this device'}</p>
        <h2>${list.length ? 'Add a client' : 'Create your first workspace'}</h2>
        <p class="muted">A workspace holds one client's surveys and responses, encrypted under its own passphrase. Nothing you put here is reachable from another client's workspace on this device.</p>
        <div class="q"><label class="lbl" for="ws-name">Client or project</label>
          <p class="hint">This name is visible before anyone unlocks, so keep it plain.</p>
          <input id="ws-name" type="text" placeholder="Northern Region" autocomplete="off" /></div>
        <div class="q"><label class="lbl" for="pass">Passphrase for this client</label>
          <p class="hint">It is never stored and cannot be recovered. Losing it loses this client's responses.</p>
          <input id="pass" type="password" autocomplete="new-password" />
          <p class="err" id="pass-err" hidden></p></div>
        <div class="q"><label class="lbl" for="pass2">Confirm passphrase</label>
          <input id="pass2" type="password" autocomplete="new-password" /></div>
        <div class="q"><label class="lbl" for="collector">Your identifier</label>
          <p class="hint">A staff code, not a name.</p>
          <input id="collector" type="text" value="GE-USER-01" /></div>
        <button class="btn wide" id="do-create">Create and continue</button>
        ${list.length ? '<button class="btn ghost wide sm" id="ws-back">Cancel</button>' : ''}
      </div>
      ${list.length ? '' : `
      <div class="card">
        <h3>Already have a backup?</h3>
        <p class="muted">Restoring brings a client's workspace onto this device. You then unlock it with the passphrase that workspace already uses — it is not in the file.</p>
        <button class="btn ghost wide sm" id="ws-restore">Restore from a backup file</button>
        <p class="err" id="restore-err" hidden></p>
        <input type="file" id="restore-file" accept="application/json,.json" hidden />
      </div>`}
      ${scopeNote}`;
    setActions('');
    if ($('ws-back')) $('ws-back').onclick = async () => { State.pickedWs = null; await renderUnlock(); };
    if ($('ws-restore')) wireRestorePicker();
    $('do-create').onclick = async () => {
      const err = $('pass-err'); err.hidden = true;
      const name = $('ws-name').value.trim();
      const pass = $('pass').value;
      const fail = (m) => { err.textContent = m; err.hidden = false; };
      if (!name) return fail('Give the workspace a name.');
      if (State.workspaces.some((w) => w.name.toLowerCase() === name.toLowerCase())) return fail('There is already a workspace with that name.');
      if (pass.length < 8) return fail('Use at least 8 characters.');
      if (pass !== $('pass2').value) return fail('The two passphrases do not match.');
      /* Two clients sharing one passphrase share one key, and the
         separation would be a label rather than a boundary. */
      for (const w of State.workspaces) {
        if ((await Crypto.derive(pass, w.salt)) === w.verifier) {
          Crypto.lock();
          return fail('Another workspace on this device already uses that passphrase. Separate clients need separate passphrases, or the separation is only a label.');
        }
      }
      Crypto.lock();
      if (!(await DB.meta('device_id'))) await DB.meta('device_id', uuidv7());
      const ws = await createWorkspace(name, pass, $('collector').value.trim());
      await openWorkspace(ws, pass);
      await audit('workspace.create', name);
      toast(`${name} is ready`);
      await Store.request();
      State.pickedWs = null;
      await renderHome(); show('home');
    };
    return;
  }

  if (picked) {
    $('scr-unlock').innerHTML = `
      <div class="card">
        <p class="eyebrow">Client workspace</p>
        <h2>${esc(picked.name)}</h2>
        <p class="muted">This releases the key that decrypts this client's responses. It opens nothing else held on this device.</p>
        <div class="q"><label class="lbl" for="pass">Passphrase</label>
          <input id="pass" type="password" autocomplete="current-password" />
          <p class="err" id="pass-err" hidden></p></div>
        <button class="btn wide" id="do-unlock">Unlock</button>
        <button class="btn ghost wide sm" id="ws-back">Choose another client</button>
      </div>
      ${scopeNote}`;
    setActions('');
    $('ws-back').onclick = async () => { State.pickedWs = null; await renderUnlock(); };
    $('do-unlock').onclick = async () => {
      const err = $('pass-err'); err.hidden = true;
      const pass = $('pass').value;
      if (pass.length < 8) { err.textContent = 'Use at least 8 characters.'; err.hidden = false; return; }
      if (!(await openWorkspace(picked, pass))) {
        err.textContent = 'That passphrase does not open this workspace.'; err.hidden = false;
        await audit('unlock.failed', picked.name, picked.id);
        return;
      }
      await audit('unlock', picked.name);
      await Store.request();
      State.pickedWs = null;
      await renderHome(); show('home');
    };
    return;
  }

  /* The picker. */
  $('scr-unlock').innerHTML = `
    <div>
      <p class="eyebrow">EPI Collect</p>
      <h2 style="margin-top:4px">Choose a client</h2>
      <p class="muted" style="margin-top:6px">Each client has its own passphrase and its own encryption key. One client's key does not open another's records — that is a different key, not a filter on a screen.</p>
    </div>
    <div class="list">
      ${list.map((w) => `
        <button class="item" data-ws="${w.id}">
          <div class="item-top"><strong>${esc(w.name)}</strong><span class="tag">Locked</span></div>
          <span class="muted mono">since ${new Date(w.created_at).toLocaleDateString()}</span>
        </button>`).join('')}
    </div>
    <div class="row">
      <button class="btn ghost sm" id="ws-new">Add a client</button>
      <button class="btn ghost sm" id="ws-restore">Restore from a backup</button>
    </div>
    <p class="err" id="restore-err" hidden></p>
    <input type="file" id="restore-file" accept="application/json,.json" hidden />
    <div class="notice warn"><b>Client names show before anything is unlocked</b>
      <span>They have to, to offer you this list — so name a workspace in a way that gives nothing away on its own. Everything inside it stays encrypted.</span></div>
    ${scopeNote}`;
  setActions('');
  $('scr-unlock').querySelectorAll('[data-ws]').forEach((b) => b.onclick = async () => {
    State.pickedWs = b.dataset.ws; await renderUnlock();
  });
  $('ws-new').onclick = async () => { State.pickedWs = '__new'; await renderUnlock(); };
  wireRestorePicker();
}

/* Restore is offered both on an empty device and from the picker. */
function wireRestorePicker() {
  $('ws-restore').onclick = () => $('restore-file').click();
  $('restore-file').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    const err = $('restore-err'); err.hidden = true;
    let obj; try { obj = JSON.parse(await f.text()); } catch { obj = null; }
    const r = await restoreBackup(obj);
    if (r.error) { err.textContent = r.error; err.hidden = false; return; }
    toast(`Restored ${r.counts.events} response${r.counts.events === 1 ? '' : 's'} into ${r.name}`);
    State.pickedWs = r.id;
    await renderUnlock();
  };
}
async function loadIdentity() {
  State.deviceId = await DB.meta('device_id');
}
/* ── Library (home) ──────────────────────────────────────────────── */
async function renderHome() {
  const subs = await submissions();
  await Store.read();
  const backup = await unbackedUp();
  const conflicts = subs.filter((s) => s.conflict).length;
  const counts = new Map();
  subs.forEach((s) => counts.set(s.latest.instrument_id, (counts.get(s.latest.instrument_id) || 0) + 1));

  $('scr-home').innerHTML = `
    <div class="clientbar">
      <span>Client · <b>${esc(State.ws.name)}</b></span>
      <button class="btn ghost sm" id="go-switch">Switch client</button>
    </div>
    <div class="stats">
      <div class="stat"><b>${State.instruments.length}</b><span>Surveys</span></div>
      <div class="stat"><b>${subs.length}</b><span>Responses</span></div>
      <div class="stat"><b>${backup.since}</b><span>Not backed up</span></div>
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
            <button class="btn ghost sm" data-share="${i.id}"${probs ? ' disabled' : ''}>Share link</button>
            <button class="btn ghost sm" data-an="${i.id}">Analyse</button>
            <button class="btn ghost sm" data-exp="${i.id}">Export</button>
          </div>
          ${State.share && State.share.id === i.id ? `
            <div class="sharebox">
              <b style="color:#fff">Anyone with this link can answer</b>
              <div class="link">${esc(State.share.url)}</div>
              <div class="row">
                <button class="btn sm" id="share-copy">Copy link</button>
                ${navigator.share ? '<button class="btn ghost sm" id="share-send">Share…</button>' : ''}
                <button class="btn ghost sm" id="share-close">Close</button>
              </div>
              <span style="font-size:.78rem">${i.endpoint
                ? `Answers post to <span class="mono">${esc(i.endpoint)}</span>.`
                : 'No collection address set, so respondents will be asked to download an answer file and send it to you — import it below. Set an address in the survey settings to receive answers automatically.'}</span>
            </div>` : ''}
          ${probs ? `<p class="err" style="font-size:.82rem">${probs} thing${probs === 1 ? '' : 's'} to finish before it can run.</p>` : ''}
        </div>`; }).join('')}
    </div>

    <div class="row">
      <button class="btn wide" id="go-newsurvey">Create a survey</button>
    </div>
    <div class="row">
      <button class="btn ghost sm" id="go-import">Import file</button>
      <button class="btn ghost sm" id="go-queue">Responses${subs.length ? ` (${subs.length})` : ''}</button>
      <button class="btn ghost sm" id="go-about">About</button>
    </div>
    ${conflicts ? `<div class="notice risk"><b>${conflicts} conflict${conflicts > 1 ? 's' : ''} to resolve</b><span>Two versions share a parent. Open Responses to review.</span></div>` : ''}

    ${Store.persisted === false ? `<div class="notice warn">
      <b>This browser has not promised to keep your data</b>
      <span>Responses stay here when you close the browser, but until storage is marked persistent the browser may clear them if the device runs short of space — and on iPhone, after about a week without opening the app. Installing it to the home screen usually settles this. Either way, keep a backup.</span>
      <div class="row" style="margin-top:4px"><button class="btn ghost sm" id="go-persist">Ask the browser to keep it</button></div></div>` : ''}

    ${backup.total ? `<div class="notice${backup.since ? ' warn' : ''}">
      <b>${backup.at ? `Last backup ${new Date(backup.at).toLocaleDateString()}` : 'No backup yet'}</b>
      <span>${backup.since
        ? `${backup.since} response${backup.since === 1 ? '' : 's'} ${backup.since === 1 ? 'is' : 'are'} on this device only. A backup is the one copy that survives a lost phone or cleared site data.`
        : 'Every response here is in a backup file.'}</span>
      <div class="row" style="margin-top:4px"><button class="btn ghost sm" id="go-backup">Back up now</button></div></div>` : ''}
    <input type="file" id="import-file" accept="application/json,.json" multiple hidden />`;

  setActions('');
  $('go-newsurvey').onclick = async () => {
    State.draft = newSurvey(); await saveDraft();
    await audit('survey.create', State.draft.id);
    renderBuilder(); show('builder');
  };
  if ($('go-persist')) $('go-persist').onclick = async (e) => {
    e.target.disabled = true;
    const got = await Store.request();
    toast(got ? 'The browser will keep this data' : 'The browser declined for now — keep a backup');
    await renderHome();
  };
  if ($('go-backup')) $('go-backup').onclick = async () => {
    await downloadBackup();
    toast('Backup saved — keep it somewhere else than this device');
    await renderHome();
  };
  $('go-switch').onclick = async () => {
    await audit('workspace.close', State.ws.name);
    closeWorkspace();
    await renderUnlock(); show('unlock');
  };
  $('go-queue').onclick = async () => { await renderQueue(); show('queue'); };
  $('go-about').onclick = async () => { await renderAbout(); show('about'); };
  $('go-import').onclick = () => $('import-file').click();
  /* One picker for both kinds of file: a survey definition, or an
     answer file a respondent sent back from a share link. */
  $('import-file').onchange = async (e) => {
    const files = [...e.target.files]; if (!files.length) return;
    let surveys = 0, responses = 0; const rejected = [];
    for (const f of files) {
      let obj;
      try { obj = JSON.parse(await f.text()); } catch { rejected.push(`${f.name}: not readable`); continue; }
      if (obj && obj.kind === BACKUP_KIND) {
        const r = await restoreBackup(obj);
        if (r.error) rejected.push(r.error);
        else if (r.id !== State.ws.id) rejected.push(`${f.name}: belongs to “${r.name}” — restored into that workspace, switch to it to see it`);
        else { surveys += r.counts.instruments; responses += r.counts.events; }
      } else if (obj && obj.kind === RESPONSE_KIND) {
        const why = await importResponse(obj);
        if (why) rejected.push(`${f.name}: ${why}`); else responses++;
      } else if (obj && Array.isArray(obj.sections)) {
        obj.id = uuidv7(); obj.updatedAt = new Date().toISOString();
        await saveInstrument(obj);
        await audit('survey.import', obj.title || '');
        surveys++;
      } else {
        rejected.push(`${f.name}: not a survey or a response`);
      }
    }
    e.target.value = '';
    State.instruments = await loadInstruments();
    const done = [surveys ? `${surveys} survey${surveys === 1 ? '' : 's'}` : '', responses ? `${responses} response${responses === 1 ? '' : 's'}` : '']
      .filter(Boolean).join(' and ');
    toast(done ? `Imported ${done}` : rejected[0] || 'Nothing imported');
    if (rejected.length && done) console.warn('Import skipped:', rejected);
    await renderHome();
  };
  $('scr-home').querySelectorAll('[data-run]').forEach((b) => b.onclick = () => startInterview(b.dataset.run));
  $('scr-home').querySelectorAll('[data-prev]').forEach((b) => b.onclick = () => startPreview(b.dataset.prev));
  $('scr-home').querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => {
    State.draft = JSON.parse(JSON.stringify(State.instruments.find((i) => i.id === b.dataset.edit)));
    renderBuilder(); show('builder');
  });
  $('scr-home').querySelectorAll('[data-share]').forEach((b) => b.onclick = async () => {
    const inst = State.instruments.find((x) => x.id === b.dataset.share);
    State.share = { id: inst.id, url: await surveyLink(inst) };
    await audit('survey.share', inst.id);
    await renderHome();
    const box = $('scr-home').querySelector('.sharebox');
    if (box) box.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
  if (State.share) {
    const url = State.share.url;
    if ($('share-copy')) $('share-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(url); toast('Link copied'); }
      catch { toast('Copy blocked — select the link and copy it'); }
    };
    if ($('share-send')) $('share-send').onclick = () => {
      const inst = State.instruments.find((x) => x.id === State.share.id);
      navigator.share({ title: inst ? inst.title : 'Survey', url }).catch(() => {});
    };
    if ($('share-close')) $('share-close').onclick = async () => { State.share = null; await renderHome(); };
  }
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
      <div class="q"><label class="lbl" for="b-end">Where link answers are sent</label>
        <p class="hint">A share link runs the survey in the respondent's browser; on its own it has no way to send answers back. Give a URL that accepts a JSON POST — a form service or your own server — and answers arrive there. Leave it empty and respondents are asked to download an answer file to send you instead.</p>
        <input id="b-end" type="text" inputmode="url" value="${esc(d.endpoint || '')}" placeholder="https://…" />
        <p class="err" id="b-end-err"${endpointProblem(d.endpoint) ? '' : ' hidden'}>${esc(endpointProblem(d.endpoint) || '')}</p></div>
      <div class="q"><label class="lbl" for="b-closing">Thank-you message</label>
        <p class="hint">Shown after a link response is sent.</p>
        <input id="b-closing" type="text" value="${esc(d.closing || '')}" placeholder="Thank you for your time." /></div>
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
  bind('b-end', 'endpoint'); bind('b-closing', 'closing');
  $('b-end').addEventListener('input', (e) => {
    const why = endpointProblem(e.target.value);
    $('b-end-err').textContent = why || '';
    $('b-end-err').hidden = !why;
  });
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
    State.instruments = await loadInstruments();
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
    </div>

    <div class="card">
      <p class="eyebrow">After this section</p>
      <p class="muted" style="font-size:.86rem">By default the next section follows. Add a rule to branch or to finish early.</p>
      ${(s.jumps || []).map((j, i) => {
        const src = allQuestions(d).find((x) => x.id === j.q);
        return `
        <div class="jumprule">
          <div class="optedit">
            <select data-jq="${i}">
              <option value="">— choose a question —</option>
              ${s.questions.map((x) => `<option value="${x.id}"${j.q === x.id ? ' selected' : ''}>${esc(x.label || x.id)}</option>`).join('')}
            </select>
            <button class="iconbtn del" data-jdel="${i}" aria-label="Remove rule">✕</button>
          </div>
          <div class="optedit" style="grid-template-columns:1fr">
            ${src && (src.options || src.type === 'yesno') ? `
              <select data-jv="${i}">
                <option value="">— answer —</option>
                ${(src.type === 'yesno' ? ['Yes', 'No'] : src.options).map((o) => `<option value="${esc(o)}"${j.val === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}
              </select>`
              : `<input type="text" data-jv="${i}" value="${esc(j.val || '')}" placeholder="answer equals…" />`}
          </div>
          <div class="optedit" style="grid-template-columns:1fr">
            <select data-jt="${i}">
              ${d.sections.map((x, xi) => `<option value="${x.id}"${j.to === x.id ? ' selected' : ''}>Go to ${xi + 1}. ${esc(x.title)}</option>`).join('')}
              <option value="__end"${j.to === '__end' ? ' selected' : ''}>Finish the survey</option>
            </select>
          </div>
        </div>`; }).join('')}
      <button class="btn ghost sm" id="s-addjump">Add rule</button>
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
  $('s-addjump').onclick = async () => {
    s.jumps = s.jumps || [];
    s.jumps.push({ q: '', val: '', to: d.sections[Math.min(State.sectionIdx + 1, d.sections.length - 1)].id });
    await saveDraft(); renderSection();
  };
  $('scr-section').querySelectorAll('[data-jq]').forEach((el) => el.onchange = async (e) => {
    s.jumps[Number(el.dataset.jq)].q = e.target.value;
    s.jumps[Number(el.dataset.jq)].val = '';
    await saveDraft(); renderSection();
  });
  $('scr-section').querySelectorAll('[data-jv]').forEach((el) => {
    const h = async (e) => { s.jumps[Number(el.dataset.jv)].val = e.target.value; await saveDraft(); };
    el.tagName === 'SELECT' ? (el.onchange = h) : el.addEventListener('input', h);
  });
  $('scr-section').querySelectorAll('[data-jt]').forEach((el) => el.onchange = async (e) => {
    s.jumps[Number(el.dataset.jt)].to = e.target.value; await saveDraft();
  });
  $('scr-section').querySelectorAll('[data-jdel]').forEach((b) => b.onclick = async () => {
    s.jumps.splice(Number(b.dataset.jdel), 1); await saveDraft(); renderSection();
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

    ${q.type === 'stars' ? `
    <div class="card"><div class="q"><label class="lbl" for="q-max">How many stars</label>
      <input id="q-max" type="number" min="3" max="10" value="${q.max || 5}" /></div></div>` : ''}

    ${q.type === 'slider' ? `
    <div class="card">
      <p class="eyebrow">Slider range</p>
      <div class="q"><label class="lbl" for="q-min">Lowest</label><input id="q-min" type="number" value="${q.min ?? 0}" /></div>
      <div class="q"><label class="lbl" for="q-max">Highest</label><input id="q-max" type="number" value="${q.max ?? 100}" /></div>
      <div class="q"><label class="lbl" for="q-step">Step</label><input id="q-step" type="number" min="1" value="${q.step || 1}" /></div>
      <div class="q"><label class="lbl" for="q-minlab">Label at the low end</label><input id="q-minlab" type="text" value="${esc(q.minLabel || '')}" /></div>
      <div class="q"><label class="lbl" for="q-maxlab">Label at the high end</label><input id="q-maxlab" type="text" value="${esc(q.maxLabel || '')}" /></div>
    </div>` : ''}

    ${q.type === 'nps' ? `
    <div class="card">
      <p class="eyebrow">End labels</p>
      <div class="q"><label class="lbl" for="q-minlab">At 0</label><input id="q-minlab" type="text" value="${esc(q.minLabel || '')}" placeholder="Not at all likely" /></div>
      <div class="q"><label class="lbl" for="q-maxlab">At 10</label><input id="q-maxlab" type="text" value="${esc(q.maxLabel || '')}" placeholder="Extremely likely" /></div>
    </div>` : ''}

    ${q.type === 'constant_sum' ? `
    <div class="card"><div class="q"><label class="lbl" for="q-total">Total to allocate</label>
      <p class="hint">The parts must add up to exactly this.</p>
      <input id="q-total" type="number" min="1" value="${q.total || 100}" /></div></div>` : ''}

    ${canOther(q.type) ? `
    <div class="card">
      <label class="opt${q.allowOther ? ' sel' : ''}">
        <input type="checkbox" id="q-other" ${q.allowOther ? 'checked' : ''} />
        <span>Offer “Other”, with a box to type in — exported as its own column</span></label>
    </div>` : ''}

    ${earlier.length ? `
    <div class="card">
      <p class="eyebrow">Quote an earlier answer</p>
      <p class="muted" style="font-size:.86rem">Paste one of these into the wording and it is replaced by what was answered.</p>
      <div class="chiprow">${earlier.map((x) => `<code style="font-size:.72rem">{{${x.id}}}</code>`).join(' ')}</div>
    </div>` : ''}

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
    if (t === 'nps') { q.min = 0; q.max = 10; }
    if (t === 'stars') q.max = q.max ?? 5;
    if (t === 'slider') { q.min = q.min ?? 0; q.max = q.max ?? 100; q.step = q.step ?? 1; }
    if (t === 'constant_sum') q.total = q.total ?? 100;
    await save(); renderQuestion();
  });
  const num = (id, key) => { const el = $(id); if (el) el.addEventListener('input', async (e) => {
    q[key] = e.target.value === '' ? undefined : Number(e.target.value); await save(); }); };
  const txt = (id, key) => { const el = $(id); if (el) el.addEventListener('input', async (e) => {
    q[key] = e.target.value || undefined; await save(); }); };
  num('q-min', 'min'); num('q-max', 'max'); num('q-maxlen', 'maxLength'); num('q-maxsel', 'maxSelections');
  num('q-step', 'step'); num('q-total', 'total');
  if ($('q-other')) $('q-other').onchange = async (e) => {
    q.allowOther = e.target.checked || undefined;
    e.target.closest('.opt').classList.toggle('sel', e.target.checked); await save();
  };
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
  State.answers = {}; State.section = 0; State.shuffled = {}; State.path = [];
  State.submissionId = uuidv7(); State.baseVersion = null;
  renderForm(); show('form');
}
function startPreview(instrumentId) {
  State.instrument = State.instruments.find((i) => i.id === instrumentId) || State.draft;
  State.preview = true;
  State.answers = {}; State.section = 0; State.shuffled = {}; State.path = [];
  renderForm(); show('form');
  toast('Preview — nothing is saved');
}

function questionHTML(q, answers, err) {
  const v = answers[q.id];
  const req = q.required ? '<span class="req" aria-hidden="true">*</span>' : '';
  const hint = q.hint ? `<p class="hint">${esc(pipe(q.hint, answers))}</p>` : '';
  const errHTML = err ? `<p class="err" id="err-${q.id}">${esc(err)}</p>` : '';
  const labelText = pipe(q.label, answers);
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
        ${choicesFor(q).map((o) => `<option value="${esc(o)}"${v === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}
      </select>` + (q.allowOther && v === OTHER ? `<input type="text" class="otherbox" data-other="${q.id}"
        value="${esc(answers[otherKey(q)] || '')}" placeholder="Please describe" />` : '');
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
      control = `<div class="opts" role="radiogroup" aria-label="${esc(q.label)}">` + choicesFor(q).map((o) => `
        <label class="opt${v === o ? ' sel' : ''}"><input type="radio" name="${q.id}" data-q="${q.id}" value="${esc(o)}" ${v === o ? 'checked' : ''} />
        <span>${esc(o)}</span></label>`).join('') + '</div>'
        + (q.allowOther && v === OTHER ? `<input type="text" class="otherbox" data-other="${q.id}"
             value="${esc(answers[otherKey(q)] || '')}" placeholder="Please describe" />` : '');
      break;
    case 'nps': {
      const btns = [];
      for (let n = 0; n <= 10; n++) {
        btns.push(`<button type="button" class="npsbtn${Number(v) === n ? ' sel' : ''}" data-q="${q.id}" data-val="${n}" aria-pressed="${Number(v) === n}">${n}</button>`);
      }
      control = `<div class="scale"><div class="npsrow">${btns.join('')}</div>
        <div class="scale-ends"><span>${esc(q.minLabel || 'Not at all likely')}</span><span>${esc(q.maxLabel || 'Extremely likely')}</span></div></div>`;
      break;
    }
    case 'stars': {
      const max = q.max || 5, btns = [];
      for (let n = 1; n <= max; n++) {
        btns.push(`<button type="button" class="starbtn${Number(v) >= n ? ' on' : ''}" data-q="${q.id}" data-val="${n}"
          aria-label="${n} of ${max}" aria-pressed="${Number(v) === n}">★</button>`);
      }
      control = `<div class="starrow">${btns.join('')}<span class="muted mono" style="margin-left:8px">${v ? `${v} / ${max}` : ''}</span></div>`;
      break;
    }
    case 'slider': {
      const cur = v ?? Math.round(((q.min ?? 0) + (q.max ?? 100)) / 2);
      control = `<div class="scale">
        <input type="range" class="slider" id="f-${q.id}" data-q="${q.id}" min="${q.min ?? 0}" max="${q.max ?? 100}"
          step="${q.step || 1}" value="${cur}" ${v === undefined ? 'data-untouched="1"' : ''} />
        <div class="scale-ends"><span>${q.min ?? 0}${esc(q.minLabel ? ' · ' + q.minLabel : '')}</span>
          <b id="sv-${q.id}" style="color:var(--brand-700)">${v === undefined ? '—' : esc(String(v))}</b>
          <span>${q.max ?? 100}${esc(q.maxLabel ? ' · ' + q.maxLabel : '')}</span></div></div>`;
      break;
    }
    case 'constant_sum': {
      const cur = v || {};
      const sum = Object.values(cur).reduce((a, x) => a + (Number(x) || 0), 0);
      control = '<div>' + (q.options || []).map((o) => `
        <div class="sumrow"><span>${esc(o)}</span>
          <input type="number" inputmode="numeric" min="0" max="${q.total}" data-sum="${q.id}" data-opt="${esc(o)}"
            value="${cur[o] ?? ''}" /></div>`).join('')
        + `<div class="sumtotal ${sum === q.total ? 'ok' : ''}">Total <b>${sum}</b> of ${q.total}</div></div>`;
      break;
    }
    case 'select_multi': {
      const arr = Array.isArray(v) ? v : [];
      control = `<div class="opts" role="group" aria-label="${esc(q.label)}">` + choicesFor(q).map((o) => `
        <label class="opt${arr.includes(o) ? ' sel' : ''}"><input type="checkbox" data-q="${q.id}" value="${esc(o)}" ${arr.includes(o) ? 'checked' : ''} />
        <span>${esc(o)}</span></label>`).join('') + '</div>'
        + (q.allowOther && arr.includes(OTHER) ? `<input type="text" class="otherbox" data-other="${q.id}"
             value="${esc(answers[otherKey(q)] || '')}" placeholder="Please describe" />` : '');
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
        <span>${esc(labelText)}${req}</span></label>${hint}${errHTML}</div>`;
    case 'geopoint':
      control = `<div class="row"><button type="button" class="btn ghost sm" data-geo="${q.id}">Capture location</button>
        <span class="muted mono" id="geo-${q.id}">${v ? esc(`${v.lat.toFixed(5)}, ${v.lon.toFixed(5)} ±${Math.round(v.acc)}m`) : 'Not captured'}</span></div>`;
      break;
    default: control = `<p class="muted">Unsupported type: ${esc(q.type)}</p>`;
  }
  return `<div class="${cls}"><label class="lbl" for="f-${q.id}">${esc(labelText)}${req}</label>${hint}${control}${errHTML}</div>`;
}

function renderForm(errs = {}) {
  const i = State.instrument, s = i.sections[State.section];
  const vis = s.questions.filter((q) => visible(q, State.answers));
  vis.forEach((q) => {
    if (q.type === 'ranking' && !Array.isArray(State.answers[q.id])) State.answers[q.id] = [...optionsFor(q)];
  });
  const pct = Math.round((State.path.length / Math.max(1, i.sections.length)) * 100);
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
    <button class="btn" id="f-next">${nextSectionIndex() === -1 ? (State.preview ? 'Finish preview' : 'Submit') : 'Continue'}</button>`);
  wireForm();
  $('f-back').onclick = async () => {
    if (!State.path.length) {
      if (State.respond) { renderRespondIntro(); return; }
      if (State.preview && State.draft) { renderBuilder(); show('builder'); return; }
      await renderHome(); show('home'); return;
    }
    State.section = State.path.pop(); renderForm();
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
  root.querySelectorAll('.npsbtn, .starbtn').forEach((el) => el.addEventListener('click', () => {
    State.answers[el.dataset.q] = Number(el.dataset.val);
    renderForm();
  }));
  root.querySelectorAll('.slider').forEach((el) => {
    const paint = () => {
      State.answers[el.dataset.q] = Number(el.value);
      const out = $(`sv-${el.dataset.q}`); if (out) out.textContent = el.value;
      el.removeAttribute('data-untouched');
      el.closest('.q').classList.remove('invalid');
    };
    el.addEventListener('input', paint);
    el.addEventListener('change', paint);
  });
  root.querySelectorAll('[data-sum]').forEach((el) => el.addEventListener('input', () => {
    const qid = el.dataset.sum;
    const cur = { ...(State.answers[qid] || {}) };
    if (el.value === '') delete cur[el.dataset.opt]; else cur[el.dataset.opt] = Number(el.value);
    State.answers[qid] = cur;
    const q = allQuestions(State.instrument).find((x) => x.id === qid);
    const sum = Object.values(cur).reduce((a, x) => a + (Number(x) || 0), 0);
    const box = el.closest('.q').querySelector('.sumtotal');
    if (box) { box.innerHTML = `Total <b>${sum}</b> of ${q.total}`; box.classList.toggle('ok', sum === q.total); }
  }));
  root.querySelectorAll('[data-other]').forEach((el) => el.addEventListener('input', () => {
    const q = allQuestions(State.instrument).find((x) => x.id === el.dataset.other);
    State.answers[otherKey(q)] = el.value;
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
  const next = nextSectionIndex();
  if (next > -1) { State.path.push(State.section); State.section = next; renderForm(); return; }
  if (State.respond) { await submitPublic(); return; }
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
    if (r.sent && SERVER_IS_REAL) toast(`Saved and transmitted${r.conflicts ? ' — conflict flagged' : ''}`);
    else if (r.conflicts) toast('Saved — conflict flagged');
  }
  await renderHome(); show('home');
}

/* ── Responses ───────────────────────────────────────────────────── */
async function renderQueue() {
  const subs = await submissions();
  const outbox = await DB.all('outbox');
  $('scr-queue').innerHTML = `
    <div><p class="eyebrow">Responses</p>
      <h2 style="margin-top:4px">${subs.length} for ${esc(State.ws.name)}</h2>
      <p class="muted" style="margin-top:6px">${SERVER_IS_REAL
        ? `${outbox.length} waiting to transmit. A response leaves the outbox only after the server confirms a durable write.`
        : 'Every one of these is on this phone and nowhere else.'}</p></div>
    ${SERVER_IS_REAL ? '' : `<div class="notice warn">
      <b>Nothing here has left this device</b>
      <span>No collection server is connected. The delivery protocol below runs against a stand-in inside this browser — it checks signatures, rejects duplicates and flags conflicts, but it moves nothing anywhere. Responses leave this phone only in a backup file or a CSV you export.</span></div>`}
    ${subs.length === 0 ? '<div class="notice"><b>Nothing collected yet</b><span>Completed interviews appear here.</span></div>' : ''}
    <div class="list">
      ${subs.map((s) => `
        <button class="item ${s.conflict ? 'conflict' : s.synced ? 'synced' : 'pending'}" data-sub="${s.id}">
          <div class="item-top"><strong>${esc(s.label)}</strong>
            <span class="tag ${s.conflict ? 'conflict' : s.synced ? 'synced' : 'pending'}">${s.conflict ? 'Conflict'
              : SERVER_IS_REAL ? (s.synced ? 'Synced' : 'Pending')
              : 'On this device'}</span></div>
          <span class="muted" style="font-size:.82rem">${esc(s.instrumentTitle)}</span>
          <span class="muted mono">v${s.version} · ${s.events.length} event${s.events.length > 1 ? 's' : ''} · ${new Date(s.capturedAt).toLocaleString()}</span>
        </button>`).join('')}
    </div>`;
  setActions(`<button class="btn ghost" id="q-back">Back</button>
    <button class="btn" id="q-sync"${outbox.length ? '' : ' disabled'}>${SERVER_IS_REAL ? 'Transmit' : 'Run delivery check'} ${outbox.length || ''}</button>`);
  $('q-back').onclick = async () => { await renderHome(); show('home'); };
  $('q-sync').onclick = async () => {
    $('q-sync').disabled = true; $('q-sync').textContent = SERVER_IS_REAL ? 'Transmitting…' : 'Checking…';
    const r = await syncOutbox();
    toast(SERVER_IS_REAL
      ? `${r.sent} sent · ${r.dupes} duplicate${r.dupes === 1 ? '' : 's'} ignored${r.conflicts ? ` · ${r.conflicts} conflict` : ''}`
      : `${r.sent} checked against the local stand-in${r.conflicts ? ` · ${r.conflicts} conflict flagged` : ''} — still only on this device`);
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
            <span class="tag ${e.synced ? 'synced' : 'pending'}">${e.synced
              ? (SERVER_IS_REAL ? 'seq ' + e.server_seq : 'checked')
              : (SERVER_IS_REAL ? 'Pending' : 'not checked')}</span></div>
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
  await Store.read();
  const backup = await unbackedUp();
  const persistTxt = Store.persisted === true
    ? 'Persistent — the browser has promised not to clear it to reclaim space.'
    : Store.persisted === false
      ? 'Best-effort — the browser may clear it if the device runs short of space, and on iPhone after about a week without opening the app. Installing to the home screen usually settles this.'
      : 'This browser does not report a storage mode.';
  $('scr-about').innerHTML = `
    <div><p class="eyebrow">About this build</p><h2 style="margin-top:4px">What it does, and what it is not</h2></div>
    <div class="notice risk"><b>Not a HIPAA-compliant system</b>
      <span>No business associate agreements are in place and no server-side controls exist. Do not enter names, addresses, phone numbers, dates of birth, record numbers, or any other identifying information.</span></div>
    <div class="card"><h3>What is real</h3>
      <ul style="margin:0;padding-left:20px;display:grid;gap:6px" class="muted">
        <li>Anyone can build a survey here — sections, eighteen question types, validation rules, piping, conditional questions and section branching</li>
        <li>Preview shows exactly what the interviewer will see</li>
        <li>Surveys export and import as JSON, so they move between devices</li>
        <li>A share link carries the whole survey inside the URL fragment, so opening it publishes nothing and reaches nothing on this device</li>
        <li>Answers from a link go to the collection address you set. Without one, a link cannot return answers — the respondent downloads a file to send you, and you import it here</li>
        <li>Works with no connectivity; every asset is cached on first load</li>
        <li>Responses encrypted on the device with AES-256-GCM, key derived from your passphrase and never stored</li>
        <li>Each operation carries a UUIDv7 idempotency key and an HMAC signature</li>
        <li>Append-only history: corrections add versions, nothing is overwritten</li>
        <li>Responses stay on the device when the browser is closed, and the app asks the browser to keep them rather than treating them as disposable cache</li>
        <li>A backup file carries surveys and responses to another device, still as ciphertext</li>
        <li>Divergent edits are flagged for a human, never resolved automatically</li>
      </ul></div>
    <div class="card"><h3>What is simulated</h3>
      <p class="muted"><b style="color:var(--navy-900)">There is no collection server.</b> <span class="mono">transmit</span> writes to an object store inside this same browser, so the delivery protocol — signatures, duplicate rejection, conflict detection — can be exercised end to end without a backend. Nothing it does moves a response off this device.</p>
      <p class="muted">Because of that, no screen in this app claims a response was transmitted or synced. Responses leave this phone in exactly two ways: a backup file, or a CSV you export. Swapping the stand-in for a real API is one function.</p></div>
    <div class="card"><h3>This client workspace</h3>
      <p class="muted"><b style="color:var(--navy-900)">${esc(State.ws.name)}</b> — opened with its own passphrase, encrypted under its own key. ${State.workspaces.length - 1
        ? `${State.workspaces.length - 1} other client workspace${State.workspaces.length === 2 ? '' : 's'} on this device ${State.workspaces.length === 2 ? 'is' : 'are'} locked and unreadable from here: a different passphrase means a different key, not a filter.`
        : 'It is the only workspace on this device.'}</p>
      <p class="muted">Surveys, responses, the outbox and this workspace's activity log are all stamped to it, and every read is filtered to the open workspace at the storage layer rather than at each screen.</p>
      <button class="btn ghost wide sm" id="a-switch">Switch to another client</button></div>

    <div class="card"><h3>Where your data lives</h3>
      <p class="muted">Everything is stored inside this browser on this device, encrypted under this workspace's passphrase. It stays there when you close the browser and when the device is offline. It is not on a server, so it is not reachable from another phone or computer — a backup file is how it moves.</p>
      <div class="stats" style="grid-template-columns:repeat(2,1fr)">
        <div class="stat"><b>${backup.total}</b><span>Stored responses</span></div>
        <div class="stat"><b>${mb(Store.usage)}</b><span>of ${mb(Store.quota)} available</span></div>
      </div>
      <div class="notice${Store.persisted === true ? '' : ' warn'}">
        <b>Storage: ${Store.persisted === true ? 'persistent' : Store.persisted === false ? 'best-effort' : 'unknown'}</b>
        <span>${persistTxt}</span></div>
      ${Store.persisted === true ? '' : '<button class="btn ghost wide sm" id="a-persist">Ask the browser to keep this data</button>'}
      <div class="divider"></div>
      <h3>Backup</h3>
      <p class="muted">${backup.at
        ? `Last backup ${new Date(backup.at).toLocaleString()}${backup.since ? ` · ${backup.since} response${backup.since === 1 ? '' : 's'} since then` : ' · nothing new since'}`
        : 'No backup has been made from this device.'}</p>
      <p class="muted">A backup covers <b style="color:var(--navy-900)">${esc(State.ws.name)}</b> only — no other client can end up inside it, so it is safe to hand to that client. The file holds the surveys and responses as ciphertext. Your passphrase is not in it and is not stored anywhere, so the file is useless without you — and useless to you if the passphrase is forgotten.</p>
      <div class="row">
        <button class="btn sm" id="a-backup">Download a backup</button>
        <button class="btn ghost sm" id="a-restore">Restore from a backup</button>
      </div>
      <input type="file" id="a-restore-file" accept="application/json,.json" hidden />
      <p class="err" id="a-restore-err" hidden></p></div>

    <div class="card"><h3>Signing in from another device</h3>
      <p class="muted">There is no account and no server behind this app, so there is nothing to sign in to from elsewhere: the data is on the device that collected it. To carry it to another device, download a backup here and restore it there with the same passphrase. Accounts that follow a client across phones and computers need a hosted backend — that is a different build, not a setting.</p></div>

    <div class="card"><h3>This device</h3>
      <p class="muted mono">device ${esc(State.deviceId || '—')}<br />user ${esc(State.collector || '—')}</p>
      <h3 style="margin-top:8px">Recent activity</h3>
      <div class="list">${log.map((a) => `<div class="item" style="cursor:default;border-left-color:var(--g-300)">
        <div class="item-top"><strong>${esc(a.action)}</strong><span class="muted mono">${new Date(a.at).toLocaleTimeString()}</span></div>
        ${a.detail ? `<span class="muted mono">${esc(a.detail)}</span>` : ''}</div>`).join('')}</div></div>
    <div class="card"><h3>Danger zone</h3>
      <p class="muted">Erasing a workspace destroys that client's surveys and responses and removes its key material. Other clients on this device are untouched. A backup taken beforehand is the only way any of it comes back.</p>
      <button class="btn danger wide" id="a-wipe-ws">Erase “${esc(State.ws.name)}”</button>
      <div class="divider"></div>
      <p class="muted">Erasing the device destroys every workspace on it, for every client.</p>
      <button class="btn danger wide" id="a-wipe">Erase this device</button></div>`;
  setActions('<button class="btn ghost wide" id="a-back">Back</button>');
  $('a-back').onclick = async () => { await renderHome(); show('home'); };
  if ($('a-persist')) $('a-persist').onclick = async (e) => {
    e.target.disabled = true;
    const got = await Store.request();
    toast(got ? 'The browser will keep this data' : 'The browser declined for now — keep a backup');
    await renderAbout();
  };
  $('a-backup').onclick = async () => {
    await downloadBackup();
    toast('Backup saved — keep it somewhere else than this device');
    await renderAbout();
  };
  $('a-switch').onclick = async () => {
    await audit('workspace.close', State.ws.name);
    closeWorkspace();
    await renderUnlock(); show('unlock');
  };
  $('a-wipe-ws').onclick = async () => {
    const name = State.ws.name;
    if (!confirm(`Erase “${name}” and everything collected for it? Other clients on this device are not affected.`)) return;
    for (const store of SCOPED) {
      for (const r of await DB.all(store)) {
        await DB.del(store, store === 'events' || store === 'outbox' ? r.op_id : store === 'server' ? r.key : r.id);
      }
    }
    State.workspaces = State.workspaces.filter((w) => w.id !== State.ws.id);
    await saveWorkspaces();
    await audit('workspace.erase', name, null);
    closeWorkspace();
    toast(`${name} erased`);
    await renderUnlock(); show('unlock');
  };
  $('a-restore').onclick = () => $('a-restore-file').click();
  $('a-restore-file').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    const err = $('a-restore-err'); err.hidden = true;
    let obj; try { obj = JSON.parse(await f.text()); } catch { obj = null; }
    const r = await restoreBackup(obj);
    if (r.error) { err.textContent = r.error; err.hidden = false; return; }
    if (r.id !== State.ws.id) {
      err.textContent = `That backup belongs to “${r.name}”, not to this workspace. It has been restored into its own workspace — switch to it to see it.`;
      err.hidden = false; return;
    }
    State.instruments = await loadInstruments();
    await audit('workspace.restore', `${r.counts.events} events`);
    toast(`Restored ${r.counts.events} response${r.counts.events === 1 ? '' : 's'} and ${r.counts.instruments} survey${r.counts.instruments === 1 ? '' : 's'}`);
    await renderAbout();
  };
  $('a-wipe').onclick = async () => {
    if (!confirm('Erase all surveys, responses and the encryption key? This cannot be undone.')) return;
    indexedDB.deleteDatabase('epi-collect'); Crypto.lock();
    setTimeout(() => location.reload(), 300);
  };
}

/* ── Boot ────────────────────────────────────────────────────────── */
/* ── Public respond mode ─────────────────────────────────────────
   Reached by opening a share link. There is no unlock, no local
   database of anyone else's answers, and nothing on this screen can
   see the owner's device. */
function renderRespondIntro() {
  const i = State.instrument;
  const qn = allQuestions(i).length;
  $('scr-respond').innerHTML = `
    <div class="respondhero">
      <p class="eyebrow">${esc(i.code || 'Survey')}</p>
      <h2>${esc(i.title)}</h2>
      ${i.subtitle ? `<p class="muted">${esc(i.subtitle)}</p>` : ''}
      <div class="meta">
        <span>${i.sections.length} section${i.sections.length === 1 ? '' : 's'}</span>
        <span>${qn} question${qn === 1 ? '' : 's'}</span>
        <span>About ${i.estimatedMinutes || 5} min</span>
      </div>
    </div>
    <div class="notice">
      <b>Your answers stay in this browser until you send them</b>
      <span>${i.endpoint
        ? `On the last screen they are sent to <span class="mono">${esc(i.endpoint)}</span>.`
        : 'This survey has no collection address, so at the end you will be asked to download your answers as a file and send it to whoever shared the link.'}</span>
    </div>`;
  setActions('<button class="btn wide" id="r-start">Start</button>');
  $('r-start').onclick = () => {
    State.answers = {}; State.section = 0; State.path = []; State.shuffled = {};
    renderForm(); show('form');
  };
  show('respond');
}

async function submitPublic() {
  const i = State.instrument;
  const body = {
    kind: RESPONSE_KIND, v: 1,
    survey_id: i.id, survey_code: i.code || '', survey_version: i.version,
    response_id: uuidv7(), submitted_at: new Date().toISOString(),
    answers: pruneHidden(State.answers, i),
  };
  State.lastResponse = body;
  let outcome = 'file';
  if (i.endpoint) {
    setActions('<button class="btn wide" disabled>Sending…</button>');
    try {
      const res = await fetch(i.endpoint, {
        method: 'POST', mode: 'cors',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      outcome = res.ok ? 'sent' : 'failed';
    } catch { outcome = 'failed'; }
  }
  renderDone(outcome); show('done');
}

function downloadResponse() {
  const b = State.lastResponse;
  const blob = new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(b.survey_code || 'response').toLowerCase()}-${b.response_id.slice(0, 8)}.json`;
  a.click(); URL.revokeObjectURL(a.href);
}

/* Three honest endings: it was sent, it could not be sent, or there was
   nowhere to send it. None of them pretends an answer was delivered. */
function renderDone(outcome) {
  const i = State.instrument;
  const heads = {
    sent: ['Answers sent', 'Thank you — your response has been delivered.'],
    failed: ['Not sent', 'The collection address did not accept the answers. Nothing has been lost: download the file below and send it to whoever shared this link.'],
    file: ['Almost done', 'This survey has no collection address, so a link cannot return your answers on its own. Download the file below and send it to whoever shared this link.'],
  };
  const [h, sub] = heads[outcome];
  $('scr-done').innerHTML = `
    <div style="display:grid; gap:14px; justify-items:start">
      <div class="donemark" aria-hidden="true">${outcome === 'sent' ? '✓' : '↓'}</div>
      <h2>${h}</h2>
      <p class="muted">${sub}</p>
    </div>
    ${outcome === 'sent' && i.closing ? `<div class="notice"><b>${esc(i.title)}</b><span>${esc(i.closing)}</span></div>` : ''}
    ${outcome === 'sent' ? '' : '<div class="notice warn"><b>Keep this file</b><span>It is the only copy of your answers. Closing this page without downloading loses them.</span></div>'}`;
  setActions(outcome === 'sent'
    ? '<button class="btn ghost wide" id="d-save">Save a copy</button>'
    : '<button class="btn wide" id="d-save">Download my answers</button>');
  $('d-save').onclick = downloadResponse;
}

/* Booting from a share link: decode, run, and never touch the vault. */
async function bootRespond(code) {
  let inst;
  try { inst = await unpackSurvey(code); } catch {
    $('scr-respond').innerHTML = `
      <h2>This link is not readable</h2>
      <p class="muted">The survey travels inside the link itself, so a truncated or edited link cannot be recovered. Ask whoever shared it to send the full link again.</p>`;
    setActions(''); show('respond'); return;
  }
  State.respond = true;
  State.instrument = inst;
  State.instruments = [inst];
  State.preview = false;
  document.title = `${inst.title} — EPI Collect`;
  renderRespondIntro();
}

async function boot() {
  netStatus();
  window.addEventListener('online', () => { netStatus(); toast('Back online'); });
  window.addEventListener('offline', () => { netStatus(); toast('Offline — capture continues'); });
  const link = /^#s=(.+)$/.exec(location.hash || '');
  if (link) {
    await bootRespond(link[1]);
  } else {
    await DB.open();
    await migrateToWorkspaces();
    await loadIdentity();
    await renderUnlock();
    show('unlock');
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
document.addEventListener('DOMContentLoaded', boot);
