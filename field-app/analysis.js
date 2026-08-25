/* =====================================================================
   GLOBAL EPI — Field Collect · analysis and export
   ---------------------------------------------------------------------
   Summarises a survey's responses and writes them out as CSV.

   Every chart here is a single-series magnitude comparison, so the form
   is a horizontal bar and the colour job is "one hue, no identity to
   encode". The bar hue was picked by running the palette validator
   rather than by eye: it clears the chroma floor and 3:1 against the
   chart surface, which the darker brand step did not.

   Bars carry direct labels rather than relying on hover, because this
   runs on a phone in the field where there is no cursor.
===================================================================== */
'use strict';

const CHART = {
  bar: '#009873',      // validated: chroma 0.10+, contrast >= 3:1 on #F6F8F7
  none: '#87918D',     // absence of an answer — deliberately gray, not a category
  grid: '#DEE5E2',
  ink: '#39413E',
  muted: '#69736F',
  surface: '#F6F8F7',
};

/* ── Statistics ──────────────────────────────────────────────────── */
const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const fmt = (n, d = 1) => (n === null ? '—' : Number(n).toFixed(d).replace(/\.0$/, ''));

/* One summary per question, shaped by what that question can be asked. */
function summarise(instrument, rows) {
  return allQuestions(instrument).map((q) => {
    const vals = rows.map((r) => r.answers[q.id]).filter((v) =>
      v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0));
    const answered = vals.length, skipped = rows.length - answered;
    const base = { q, answered, skipped, kind: 'none' };

    if (['select_one', 'dropdown', 'yesno', 'select_multi'].includes(q.type)) {
      const opts = q.type === 'yesno' ? ['Yes', 'No'] : (q.options || []);
      const counts = new Map(opts.map((o) => [o, 0]));
      vals.forEach((v) => (Array.isArray(v) ? v : [v]).forEach((x) => {
        if (counts.has(x)) counts.set(x, counts.get(x) + 1);
      }));
      if (q.allowOther) {
        const n = vals.filter((v) => (Array.isArray(v) ? v.includes('Other') : v === 'Other')).length;
        counts.set('Other', n);
      }
      const others = q.allowOther
        ? rows.map((r) => r.answers[`${q.id}__other`]).filter((t) => t !== undefined && String(t).trim() !== '').map(String)
        : [];
      return { ...base, kind: 'categorical', multi: q.type === 'select_multi', others,
        bars: [...counts].map(([label, value]) => ({ label, value })) };
    }
    if (q.type === 'checkbox') {
      const yes = vals.filter((v) => v === true).length;
      return { ...base, kind: 'categorical',
        bars: [{ label: 'Confirmed', value: yes }, { label: 'Not confirmed', value: rows.length - yes }] };
    }
    /* NPS is not a mean. The published definition is the share of
       promoters minus the share of detractors, on answered responses
       only, and reporting an average of 0–10 instead would be a
       different number wearing the same name. */
    if (q.type === 'nps') {
      const n = vals.map(num).filter((v) => v !== null && Number.isFinite(v));
      const detr = n.filter((v) => v <= 6).length;
      const pass = n.filter((v) => v >= 7 && v <= 8).length;
      const prom = n.filter((v) => v >= 9).length;
      const pct = (x) => (n.length ? (x / n.length) * 100 : 0);
      const bins = [];
      for (let i = 0; i <= 10; i++) bins.push({ label: String(i), value: n.filter((v) => v === i).length });
      return { ...base, kind: 'nps',
        score: n.length ? Math.round(pct(prom) - pct(detr)) : null,
        groups: [
          { label: `Promoters (9–10)  ${Math.round(pct(prom))}%`, value: prom },
          { label: `Passives (7–8)  ${Math.round(pct(pass))}%`, value: pass },
          { label: `Detractors (0–6)  ${Math.round(pct(detr))}%`, value: detr },
        ],
        bars: bins };
    }
    /* Allocation: the readable summary is what an average respondent
       gave each option, out of the fixed total. */
    if (q.type === 'constant_sum') {
      const opts = q.options || [];
      const rowsOut = opts.map((o) => {
        const n = vals.map((v) => num(v && v[o])).filter((x) => x !== null && Number.isFinite(x));
        return { label: o, value: mean(n.length ? n : [0]) ?? 0, n: n.length };
      });
      return { ...base, kind: 'alloc', total: q.total || 100, bars: rowsOut };
    }
    if (['scale', 'integer', 'number', 'stars', 'slider'].includes(q.type)) {
      const n = vals.map(num).filter((v) => v !== null && Number.isFinite(v));
      /* Bins are an array, not a map keyed by label: over a narrow range two
         bins round to the same caption, and a map silently merged them —
         which then indexed past the end and produced an "undefined / NaN"
         bar. Counts also read better one-value-per-bar than in six
         arbitrary slices, so a small integer range gets exact bins. */
      let bins = [];
      if (n.length) {
        const lo = Math.min(...n), hi = Math.max(...n);
        const allInt = n.every((v) => Number.isInteger(v));
        const exact = (q.type === 'scale' && q.min != null && q.max != null)
          ? { from: q.min, to: q.max }
          : (q.type === 'stars' ? { from: 1, to: q.max || 5 }
          : (allInt && hi - lo <= 12 ? { from: lo, to: hi } : null));

        if (exact) {
          for (let i = exact.from; i <= exact.to; i++) bins.push({ label: String(i), value: 0, lo: i, hi: i });
          n.forEach((v) => { const b = bins.find((x) => x.lo === v); if (b) b.value++; });
        } else {
          const span = (hi - lo) || 1, count = 6;
          for (let i = 0; i < count; i++) {
            const a = lo + (span / count) * i, bEdge = lo + (span / count) * (i + 1);
            bins.push({ label: `${fmt(a, 1)}–${fmt(bEdge, 1)}`, value: 0, lo: a, hi: bEdge });
          }
          n.forEach((v) => {
            const i = Math.min(count - 1, Math.floor(((v - lo) / span) * count));
            bins[i].value++;
          });
        }
      }
      return { ...base, kind: 'numeric',
        stats: { n: n.length, mean: mean(n), median: median(n),
                 min: n.length ? Math.min(...n) : null, max: n.length ? Math.max(...n) : null },
        bars: bins.map(({ label, value }) => ({ label, value })) };
    }
    if (q.type === 'matrix') {
      const rowsOut = (q.rows || []).map((rowLabel) => {
        const n = vals.map((v) => num(v && v[rowLabel])).filter((v) => v !== null && Number.isFinite(v));
        return { label: rowLabel, value: mean(n), n: n.length };
      });
      return { ...base, kind: 'matrix', scale: { min: q.min ?? 1, max: q.max ?? 5 }, bars: rowsOut };
    }
    if (q.type === 'ranking') {
      const opts = q.options || [];
      const rowsOut = opts.map((o) => {
        const ranks = vals.map((v) => (Array.isArray(v) ? v.indexOf(o) + 1 : 0)).filter((r) => r > 0);
        return { label: o, value: mean(ranks), n: ranks.length };
      }).sort((a, b) => (a.value ?? 99) - (b.value ?? 99));
      return { ...base, kind: 'ranking', worst: opts.length, bars: rowsOut };
    }
    if (['text', 'textarea'].includes(q.type)) {
      return { ...base, kind: 'text', samples: vals.slice(-5).reverse().map(String) };
    }
    if (q.type === 'date') {
      const ds = vals.map(String).sort();
      return { ...base, kind: 'range', from: ds[0] || null, to: ds[ds.length - 1] || null };
    }
    if (q.type === 'geopoint') return { ...base, kind: 'count' };
    return base;
  });
}

/* ── Bar chart ───────────────────────────────────────────────────────
   Horizontal bars: category labels read left-to-right without rotation,
   which is what makes them right for a narrow screen.                */
function barChart(bars, opts = {}) {
  const { valueMax, decimals = 0, suffix = '', neutralLast = false } = opts;
  if (!bars.length) return '<p class="muted">Nothing to chart yet.</p>';
  const max = valueMax ?? Math.max(1, ...bars.map((b) => b.value || 0));
  const rowH = 34, gap = 6, labelW = 0, W = 300;
  const H = bars.length * (rowH + gap) - gap;

  const marks = bars.map((b, i) => {
    const y = i * (rowH + gap);
    const v = b.value ?? 0;
    const w = Math.max(v > 0 ? 3 : 0, (v / max) * W);
    const colour = neutralLast && i === bars.length - 1 ? CHART.none : CHART.bar;
    const shown = `${fmt(v, decimals)}${suffix}`;
    return `
      <g>
        <title>${esc(b.label)}: ${esc(shown)}</title>
        <text x="0" y="${y + 12}" font-size="12" fill="${CHART.ink}">${esc(b.label)}</text>
        <rect x="0" y="${y + 18}" width="${W}" height="10" rx="5" fill="${CHART.grid}" />
        <rect x="0" y="${y + 18}" width="${w}" height="10" rx="5" fill="${colour}" />
        <text x="${W + 8}" y="${y + 27}" font-size="12" font-weight="600" fill="${CHART.ink}"
          style="font-variant-numeric:tabular-nums">${esc(shown)}</text>
      </g>`;
  }).join('');

  return `<svg viewBox="0 0 ${W + 54} ${H}" role="img" style="width:100%;height:auto;overflow:visible"
    aria-label="${esc(bars.map((b) => `${b.label}: ${fmt(b.value ?? 0, decimals)}${suffix}`).join('; '))}">
    ${marks}</svg>`;
}

/* ── CSV ─────────────────────────────────────────────────────────────
   One row per response, latest version. A UTF-8 BOM is prepended
   because Excel otherwise reads accented characters as mojibake, which
   matters for every place name on this island.                       */
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCSV(instrument, rows) {
  const qs = allQuestions(instrument);
  const head = ['response_id', 'version', 'source', 'collector', 'device', 'captured_at', 'synced', 'conflict'];
  const cols = [];
  qs.forEach((q) => {
    if (q.type === 'matrix') (q.rows || []).forEach((r) => cols.push({ q, sub: r, header: `${q.label} — ${r}` }));
    else if (q.type === 'ranking') (q.options || []).forEach((o) => cols.push({ q, rank: o, header: `${q.label} — rank of ${o}` }));
    else if (q.type === 'constant_sum') (q.options || []).forEach((o) => cols.push({ q, alloc: o, header: `${q.label} — ${o}` }));
    else if (q.type === 'geopoint') { cols.push({ q, geo: 'lat', header: `${q.label} (lat)` }); cols.push({ q, geo: 'lon', header: `${q.label} (lon)` }); }
    else cols.push({ q, header: q.label || q.id });
    if (q.type === 'nps') cols.push({ q, npsGroup: true, header: `${q.label} — group` });
    if (q.allowOther) cols.push({ q, other: true, header: `${q.label} — other` });
  });

  const lines = [[...head, ...cols.map((c) => c.header)].map(csvCell).join(',')];
  rows.forEach((r) => {
    const meta = [r.id, r.version, r.via || 'interview', r.collector, r.device, r.capturedAt, r.synced ? 'yes' : 'no', r.conflict ? 'yes' : 'no'];
    const cells = cols.map((c) => {
      /* Written-in text lives beside the answer, so it is read before
         the empty-answer guard below. */
      if (c.other) return r.answers[`${c.q.id}__other`] ?? '';
      const v = r.answers[c.q.id];
      if (v === undefined || v === null) return '';
      if (c.npsGroup) { const n = Number(v); return Number.isFinite(n) ? (n >= 9 ? 'promoter' : n >= 7 ? 'passive' : 'detractor') : ''; }
      if (c.alloc) return v[c.alloc] ?? '';
      if (c.sub) return v[c.sub] ?? '';
      if (c.rank) { const i = Array.isArray(v) ? v.indexOf(c.rank) : -1; return i >= 0 ? i + 1 : ''; }
      if (c.geo) return v[c.geo] ?? '';
      if (Array.isArray(v)) return v.join('; ');
      if (typeof v === 'boolean') return v ? 'yes' : 'no';
      if (typeof v === 'object') return JSON.stringify(v);
      return v;
    });
    lines.push([...meta, ...cells].map(csvCell).join(','));
  });
  return '﻿' + lines.join('\r\n');
}

function download(name, text, mime) {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ── Decrypted rows for one instrument ───────────────────────────── */
async function responseRows(instrumentId) {
  const subs = (await submissions(instrumentId));
  const out = [];
  for (const s of subs) {
    let answers = {};
    try { answers = await Crypto.decrypt(s.latest.payload); } catch { continue; }
    out.push({ id: s.id, version: s.version, collector: s.latest.collector_id,
      via: s.latest.via || 'interview',
      device: s.latest.device_id, capturedAt: s.capturedAt,
      synced: s.synced, conflict: s.conflict, answers });
  }
  return out;
}

/* ── Screen ──────────────────────────────────────────────────────── */
async function renderAnalysis(instrumentId) {
  const inst = State.instruments.find((i) => i.id === instrumentId);
  if (!inst) { await renderHome(); show('home'); return; }
  State.analysisId = instrumentId;
  const rows = await responseRows(instrumentId);
  const sums = summarise(inst, rows);
  const dates = rows.map((r) => r.capturedAt).sort();
  const collectors = new Set(rows.map((r) => r.collector));
  const conflicts = rows.filter((r) => r.conflict).length;

  const block = (s) => {
    const head = `
      <div class="item-top" style="align-items:flex-start">
        <strong style="color:var(--navy-900);font-size:.95rem;line-height:1.35">${esc(s.q.label || s.q.id)}</strong>
        <span class="tag">${esc(typeName(s.q.type))}</span>
      </div>
      <p class="muted" style="font-size:.78rem">${s.answered} answered${s.skipped ? ` · ${s.skipped} skipped` : ''}</p>`;

    if (s.answered === 0) return `<div class="card">${head}<p class="muted">No answers yet.</p></div>`;

    if (s.kind === 'categorical') {
      const total = s.multi ? s.answered : s.bars.reduce((a, b) => a + b.value, 0) || 1;
      const withPct = s.bars.map((b) => ({ ...b, label: `${b.label}  ${Math.round((b.value / total) * 100)}%` }));
      return `<div class="card">${head}
        ${s.multi ? '<p class="muted" style="font-size:.78rem">Percentages are of respondents, so they sum above 100.</p>' : ''}
        <div class="chartwrap">${barChart(withPct)}</div>
        ${(s.others || []).length ? `<div class="divider"></div>
          <p class="muted" style="font-size:.78rem">“Other”, in their own words — ${s.others.length} written in</p>
          <div class="list">${s.others.slice(-5).reverse().map((t) => `<div class="item" style="cursor:default;border-left-color:var(--g-300)">
            <span style="font-size:.88rem">${esc(t)}</span></div>`).join('')}</div>` : ''}</div>`;
    }
    if (s.kind === 'numeric') {
      return `<div class="card">${head}
        <div class="stats" style="grid-template-columns:repeat(4,1fr)">
          <div class="stat"><b>${fmt(s.stats.mean)}</b><span>Mean</span></div>
          <div class="stat"><b>${fmt(s.stats.median)}</b><span>Median</span></div>
          <div class="stat"><b>${fmt(s.stats.min, 0)}</b><span>Min</span></div>
          <div class="stat"><b>${fmt(s.stats.max, 0)}</b><span>Max</span></div>
        </div>
        <div class="chartwrap">${barChart(s.bars)}</div></div>`;
    }
    if (s.kind === 'nps') {
      return `<div class="card">${head}
        <div class="stats" style="grid-template-columns:repeat(2,1fr)">
          <div class="stat"><b>${s.score === null ? '—' : s.score}</b><span>NPS</span></div>
          <div class="stat"><b>${s.answered}</b><span>Scored</span></div>
        </div>
        <p class="muted" style="font-size:.78rem">Promoters minus detractors, as a share of those who answered. The range is −100 to +100.</p>
        <div class="chartwrap">${barChart(s.groups)}</div>
        <div class="divider"></div>
        <p class="muted" style="font-size:.78rem">Every score given</p>
        <div class="chartwrap">${barChart(s.bars)}</div></div>`;
    }
    if (s.kind === 'alloc') {
      return `<div class="card">${head}
        <p class="muted" style="font-size:.78rem">Mean amount given to each option, out of ${s.total}.</p>
        <div class="chartwrap">${barChart(s.bars, { valueMax: s.total, decimals: 1 })}</div></div>`;
    }
    if (s.kind === 'matrix') {
      return `<div class="card">${head}
        <p class="muted" style="font-size:.78rem">Mean rating per row, ${s.scale.min}–${s.scale.max}.</p>
        <div class="chartwrap">${barChart(s.bars, { valueMax: s.scale.max, decimals: 2 })}</div></div>`;
    }
    if (s.kind === 'ranking') {
      return `<div class="card">${head}
        <p class="muted" style="font-size:.78rem">Mean position — shorter is ranked higher.</p>
        <div class="chartwrap">${barChart(s.bars, { valueMax: s.worst, decimals: 2 })}</div></div>`;
    }
    if (s.kind === 'text') {
      return `<div class="card">${head}
        <p class="muted" style="font-size:.78rem">Most recent answers</p>
        <div class="list">${s.samples.map((t) => `<div class="item" style="cursor:default;border-left-color:var(--g-300)">
          <span style="font-size:.88rem">${esc(t)}</span></div>`).join('')}</div></div>`;
    }
    if (s.kind === 'range') {
      return `<div class="card">${head}
        <p class="muted mono">${esc(s.from || '—')} → ${esc(s.to || '—')}</p></div>`;
    }
    return `<div class="card">${head}<p class="muted">${s.answered} captured.</p></div>`;
  };

  $('scr-analysis').innerHTML = `
    <div><p class="eyebrow">Analysis</p>
      <h2 style="margin-top:4px">${esc(inst.title)}</h2>
      <p class="muted" style="font-size:.84rem">${esc(inst.code || '')} · v${inst.version}</p></div>

    <div class="stats">
      <div class="stat"><b>${rows.length}</b><span>Responses</span></div>
      <div class="stat"><b>${collectors.size}</b><span>Collectors</span></div>
      <div class="stat"><b>${conflicts}</b><span>Conflicts</span></div>
    </div>

    ${rows.length === 0 ? '<div class="notice"><b>No responses yet</b><span>Collect some and the summaries appear here.</span></div>' : `
      <div class="notice"><b>Collected</b>
        <span>${new Date(dates[0]).toLocaleDateString()} — ${new Date(dates[dates.length - 1]).toLocaleDateString()}</span></div>`}

    ${sums.map(block).join('')}

    ${rows.length ? `<div class="notice warn"><b>Before you analyse this elsewhere</b>
      <span>Summaries are computed on this device from the latest version of each response. Responses flagged as conflicts are included; resolve them first if that matters for your analysis.</span></div>` : ''}`;

  setActions(`
    <button class="btn ghost" id="an-back">Back</button>
    <button class="btn" id="an-csv"${rows.length ? '' : ' disabled'}>Download CSV</button>`);

  $('an-back').onclick = async () => { await renderHome(); show('home'); };
  $('an-csv').onclick = async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    download(`${(inst.code || 'survey').toLowerCase()}-responses-${stamp}.csv`,
      toCSV(inst, rows), 'text/csv;charset=utf-8;');
    await audit('responses.export', `${inst.code} · ${rows.length} rows`);
    toast(`${rows.length} response${rows.length === 1 ? '' : 's'} exported`);
  };
}
