// Workspace renderers (Habitat05_03 §8.3): Systems (power and its trend, equipment, slots, hand
// assembly, storage, work), the Workbench (experiments, fabrication, recent results, known
// discoveries), a Machine's controls (state, order, batches, abort, enable, study) and the
// Journal (a global utility: searchable, read-only). They render the observer's
// projection and forward requests; they never decide outcomes. Rows are keyed
// by stable ids and patched in place, so a pending confirmation or a focused control survives
// progress updates (PF-23). Sample selection is transient UI state.
import { renderPowerStrip, renderStorageBar, renderProgress, renderTrend } from './charts.js';

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const setText = (n, t) => { if (n.textContent !== t) n.textContent = t; };
let reasonIds = 0;   // unique ids for aria-describedby (no Math.random, PF-31)

/** Patch `container` to show `items` keyed by `key(item)`, creating rows once and updating them in place. */
function syncList(container, items, key, create, update) {
  const existing = new Map([...container.children].map(c => [c.dataset.key, c]));
  const wanted = new Set(items.map(key));
  for (const [k, n] of existing) if (!wanted.has(k)) n.remove();
  items.forEach((item, i) => {
    const k = key(item);
    let row = existing.get(k);
    if (!row) { row = create(item); row.dataset.key = k; }
    update(row, item);
    if (container.children[i] !== row) container.insertBefore(row, container.children[i] || null);
  });
}

function actionButton(onAction) {
  const wrap = el('div', 'sf-action');
  const b = el('button', 'sf-btn sf-btn-primary');
  b.type = 'button';
  const r = el('span', 'sf-reason');
  r.id = `sf-wsr-${++reasonIds}`;
  b.addEventListener('click', () => { if (!b.disabled && wrap._action) onAction(wrap._action); });
  wrap.append(b, r);
  return wrap;
}
function updateButton(wrap, action, label = action.label) {
  wrap._action = action;
  const [b, r] = wrap.children;
  setText(b, label);
  b.disabled = action.enabled === false;
  // The "already busy" state is already shown by the work-in-progress panel; repeating it under every button is noise.
  const showReason = action.enabled === false && action.reason && !action.reason.startsWith('You are already busy');
  setText(r, showReason ? action.reason : '');
  r.hidden = !r.textContent;
  if (r.textContent) b.setAttribute('aria-describedby', r.id); else b.removeAttribute('aria-describedby');
}

function section(title) {
  const s = el('section', 'sf-ws-section');
  s.append(el('h3', 'sf-h', title));
  return s;
}

/**
 * @param body      workspace body element
 * @param onAction  (action) → void: forwards a projected action (by id) to the shell
 * @param preview   (methodId, samples) → experiment preview projection
 * @param confirm   (message) → boolean
 */
export function createWorkspaceRenderer(body, { onAction, preview, confirm }) {
  let kind = null, parts = null;
  const selection = { methodId: null, samples: new Set() };

  function buildSystems() {
    const power = section('Power'), work = section('Work in progress'), equipment = section('Equipment'), slotsSec = section('Installation slots'),
      hand = section('Assemble by hand'), storage = section('Storage');
    const strip = el('div', 'sf-chart'), trend = el('div', 'sf-chart sf-chart-trend'), progress = el('div', 'sf-chart'), banks = el('ul', 'sf-rows'), slots = el('ul', 'sf-rows'),
      assemble = el('ul', 'sf-rows'), assembleEmpty = el('p', 'sf-muted'), bar = el('div', 'sf-chart'), items = el('ul', 'sf-rows');
    power.append(strip, trend); work.append(progress); equipment.append(banks); slotsSec.append(slots); hand.append(assemble, assembleEmpty); storage.append(bar, items);
    body.replaceChildren(power, work, equipment, slotsSec, hand, storage);
    return { strip, trend, progress, banks, slots, assemble, assembleEmpty, bar, items };
  }

  function renderSystems(m) {
    renderPowerStrip(parts.strip, m.power);
    // The trend is session presentation state the shell attaches (A-03); a failure never breaks the workspace.
    parts.trend.hidden = !m.trend;
    if (m.trend) { try { renderTrend(parts.trend, m.trend); } catch { parts.trend.replaceChildren(el('p', 'sf-muted', 'Trend unavailable.')); delete parts.trend.dataset.chart; } }
    renderProgress(parts.progress, m.work);
    syncList(parts.banks, m.banks, b => b.id, () => {
      const li = el('li', 'sf-row sf-row-action');
      li.append(el('span', 'sf-row-text'), actionButton(onAction));
      return li;
    }, (row, b) => {
      setText(row.firstChild, `${b.label} ×${b.quantity} · ${b.place} · ${b.summary}`);
      row.dataset.state = b.status ? b.status.toLowerCase().replace(' ', '-') : !b.operational ? 'offline' : b.health < 100 ? 'damaged' : 'ok';
      if (b.battery) row.dataset.cueTarget = 'battery'; else delete row.dataset.cueTarget;
      row.lastChild.hidden = !b.controls;
      if (b.controls) updateButton(row.lastChild, b.controls);
    });
    syncList(parts.slots, m.slots ?? [], x => x.id, () => el('li', 'sf-row'), (row, x) => setText(row, x.text));
    syncList(parts.assemble, m.assemble ?? [], r => r.id, () => {
      const li = el('li', 'sf-row sf-row-action');
      li.append(el('span', 'sf-row-text'), actionButton(onAction));
      return li;
    }, (row, r) => {
      setText(row.firstChild, r.detail);
      updateButton(row.lastChild, r);
    });
    setText(parts.assembleEmpty, (m.assemble ?? []).length ? '' : 'You know no products you can assemble by hand yet.');
    renderStorageBar(parts.bar, m.storage);
    syncList(parts.items, m.storage.items, i => i.itemId, () => {
      const li = el('li', 'sf-row sf-row-action');
      li.append(el('span', 'sf-row-text'), actionButton(a => { if (confirm(a.confirm)) onAction({ ...a, id: `${a.id}:confirmed` }); }));
      return li;
    }, (row, i) => {
      setText(row.firstChild, `${i.label} · ${i.qty}`);
      updateButton(row.lastChild, { ...i.discard, enabled: true });
    });
  }

  function buildWorkbench() {
    const exp = section('Experiment'), fab = section('Fabrication'), results = section('Recent results'), known = section('Known discoveries');
    const method = el('select', 'sf-select');
    method.setAttribute('aria-label', 'Experiment method');
    const samples = el('fieldset', 'sf-samples');
    samples.append(el('legend', 'sf-k', 'SAMPLES · one of each selected item is consumed'));
    const sampleList = el('div', 'sf-sample-list'), empty = el('p', 'sf-muted');
    samples.append(sampleList, empty);
    const cost = el('p', 'sf-muted'), tendencies = el('p', 'sf-muted'), reason = el('p', 'sf-reason');
    const run = el('button', 'sf-btn sf-btn-primary', 'Run experiment');
    run.type = 'button';
    run.addEventListener('click', () => {
      if (run.disabled) return;
      onAction({ id: `experiment:${selection.methodId}:${[...selection.samples].sort().join(',')}`, kind: 'command' });
    });
    method.addEventListener('change', () => { selection.methodId = method.value; selection.samples.clear(); refreshPreview(); });
    sampleList.addEventListener('change', e => {
      const id = e.target.dataset?.sample;
      if (!id) return;
      if (e.target.checked) selection.samples.add(id); else selection.samples.delete(id);
      refreshPreview();
    });
    const progress = el('div', 'sf-chart');
    exp.append(method, samples, cost, tendencies, reason, run, progress);
    const recipes = el('ul', 'sf-rows'), recipesEmpty = el('p', 'sf-muted');
    fab.append(recipes, recipesEmpty);
    const count = el('p', 'sf-muted'), list = el('ol', 'sf-results');
    results.append(count, list);
    const discoveries = el('ul', 'sf-rows'), discEmpty = el('p', 'sf-muted');
    known.append(discoveries, discEmpty);
    body.replaceChildren(exp, fab, results, known);
    return { method, sampleList, empty, cost, tendencies, reason, run, progress, recipes, recipesEmpty, count, list, discoveries, discEmpty, model: null };
  }

  function refreshPreview() {
    const m = parts.model;
    const method = m.methods.find(x => x.id === selection.methodId);
    const max = method?.maxSamples ?? 3;
    for (const box of parts.sampleList.querySelectorAll('input[data-sample]')) {
      box.checked = selection.samples.has(box.dataset.sample);
      box.disabled = !box.checked && selection.samples.size >= max;
    }
    const p = selection.samples.size ? preview(selection.methodId, [...selection.samples]) : null;
    setText(parts.cost, p ? p.cost : 'Select samples to review the cost.');
    setText(parts.tendencies, p?.tendencies ?? '');
    setText(parts.reason, p ? p.reason : '');
    parts.reason.dataset.ok = String(!!p?.ok);
    parts.run.disabled = !p?.ok;
  }

  function renderWorkbench(m) {
    parts.model = m;
    if (!m.methods.some(x => x.id === selection.methodId)) selection.methodId = m.methods[0]?.id ?? null;
    syncList(parts.method, m.methods, x => x.id, x => new Option(x.name, x.id), (o, x) => setText(o, x.name));
    parts.method.value = selection.methodId ?? '';
    const method = m.methods.find(x => x.id === selection.methodId);
    const samples = method?.samples ?? [];
    for (const id of [...selection.samples]) if (!samples.some(s => s.itemId === id)) selection.samples.delete(id);   // unavailable selections clear
    syncList(parts.sampleList, samples, s => s.itemId, s => {
      const label = el('label', 'sf-sample');
      const box = el('input'); box.type = 'checkbox'; box.dataset.sample = s.itemId;
      label.append(box, el('span'), el('small', 'sf-muted'));
      return label;
    }, (label, s) => {
      setText(label.children[1], s.label);
      setText(label.children[2], ` ${s.held} held · sample ${s.sample}`);
    });
    setText(parts.empty, samples.length ? '' : 'Nothing you hold here can provide new evidence right now. New materials, knowledge or clues may open more research.');
    refreshPreview();
    renderProgress(parts.progress, m.work);
    syncList(parts.recipes, m.recipes, r => r.id, () => {
      const li = el('li', 'sf-row sf-row-action');
      li.append(el('span', 'sf-row-text'), actionButton(onAction));
      return li;
    }, (row, r) => {
      setText(row.firstChild, r.detail);
      updateButton(row.lastChild, r);
    });
    setText(parts.recipesEmpty, m.recipes.length ? '' : 'You know no fabrication methods yet.');
    setText(parts.count, m.attemptCount ? `${m.attemptCount} experiment${m.attemptCount === 1 ? '' : 's'} recorded.` : 'No experiments recorded yet.');
    syncList(parts.list, m.results, r => r.id, () => {
      const li = el('li', 'sf-result');
      li.append(el('h4', 'sf-result-title'), el('p', 'sf-muted'), el('p', 'sf-result-outcome'));
      return li;
    }, (li, r) => {
      setText(li.children[0], r.title);
      setText(li.children[1], r.observations.join(' '));
      setText(li.children[2], r.outcome);
      li.dataset.discovery = String(r.outcome.startsWith('Discovered'));
    });
    syncList(parts.discoveries, m.discoveries, d => d.id, () => el('li', 'sf-row'), (row, d) => setText(row, `${d.name} — ${d.description} (${d.families.join(', ')})`));
    setText(parts.discEmpty, m.discoveries.length ? '' : 'No discoveries yet.');
  }

  // ---------------------------------------------------------------- machine controls
  const orderForm = { processId: null, mode: 'count', count: 1 };

  function buildMachine() {
    const state = section('State'), orderSec = section('Order'), batches = section('Batches');
    const status = el('p', 'sf-machine-status'), units = el('p', 'sf-muted');
    state.append(status, units);
    const orderText = el('p', 'sf-muted');
    const process = el('select', 'sf-select');
    process.setAttribute('aria-label', 'Process');
    const processDetail = el('p', 'sf-muted');
    const modes = el('fieldset', 'sf-samples');
    modes.append(el('legend', 'sf-k', 'HOW MANY'));
    const countLabel = el('label', 'sf-sample'), countRadio = el('input'), count = el('input');
    countRadio.type = 'radio'; countRadio.name = 'sf-order-mode'; countRadio.value = 'count';
    count.type = 'number'; count.min = '1'; count.step = '1'; count.className = 'sf-count'; count.setAttribute('aria-label', 'Number of batches');
    countLabel.append(countRadio, el('span', null, 'Make '), count, el('span', null, ' batches'));
    const repeatLabel = el('label', 'sf-sample'), repeatRadio = el('input');
    repeatRadio.type = 'radio'; repeatRadio.name = 'sf-order-mode'; repeatRadio.value = 'repeat';
    repeatLabel.append(repeatRadio, el('span', null, 'Repeat until stopped'));
    modes.append(countLabel, repeatLabel);
    const start = actionButton(onAction), stop = actionButton(onAction);
    process.addEventListener('change', () => { orderForm.processId = process.value; refreshOrder(); });
    for (const r of [countRadio, repeatRadio]) r.addEventListener('change', () => { if (r.checked) { orderForm.mode = r.value; refreshOrder(); } });
    count.addEventListener('input', () => { const n = Math.floor(Number(count.value)); if (n >= 1) orderForm.count = n; refreshOrder(); });
    orderSec.append(orderText, process, processDetail, modes, start, stop);
    const runs = el('ul', 'sf-rows'), runsEmpty = el('p', 'sf-muted');
    const abort = actionButton(a => { if (confirm(a.confirm)) onAction(a); });
    batches.append(runs, runsEmpty, abort);
    // Engineering studies (S-51): present only when a study is ready.
    const study = section('Study'), studies = el('ul', 'sf-rows');
    study.append(studies);
    body.replaceChildren(state, orderSec, batches, study);
    return { status, units, orderText, process, processDetail, countRadio, repeatRadio, count, start, stop, runs, runsEmpty, abort, study, studies, model: null };
  }

  function refreshOrder() {
    const m = parts.model;
    const p = m.processes.find(x => x.id === orderForm.processId);
    parts.countRadio.checked = orderForm.mode === 'count';
    parts.repeatRadio.checked = orderForm.mode === 'repeat';
    if (document.activeElement !== parts.count) parts.count.value = String(orderForm.count);
    parts.count.max = String(m.maxCount);
    parts.count.disabled = orderForm.mode !== 'count';
    setText(parts.processDetail, p ? p.detail : '');
    const n = Math.min(m.maxCount, Math.max(1, orderForm.count));
    // Giving an order while one is active replaces it: its running batches finish but count toward nothing.
    const verb = m.hasOrder ? 'Replace order' : 'Start';
    const label = !p ? 'Start order' : orderForm.mode === 'count' ? `${verb}: make ${n} batch${n === 1 ? '' : 'es'}` : `${verb}: repeat until stopped`;
    updateButton(parts.start, {
      id: `${m.orderAction}:${orderForm.processId ?? ''}:${orderForm.mode}:${n}`, kind: 'command',
      enabled: !!p && p.enabled, reason: !p ? 'This machine has no process you understand yet.' : p.reason
    }, label);
  }

  /** The order line, with the made count flashing green whenever a batch completes. */
  function renderOrderText(m) {
    const t = parts.orderText, key = `${m.id}|${m.orderText}`;
    const grew = parts.lastMade && parts.lastMade.id === m.id && m.made !== null && m.made > parts.lastMade.made;
    parts.lastMade = { id: m.id, made: m.made ?? 0 };
    if (t.dataset.text === key && !grew) return;
    t.dataset.text = key;
    const token = m.made === null ? '' : `${m.made} made`, i = token ? m.orderText.indexOf(token) : -1;
    if (i < 0) { t.textContent = m.orderText; return; }
    const num = el('span', 'sf-made', token);
    if (grew) num.classList.add('sf-made-flash');
    t.replaceChildren(m.orderText.slice(0, i), num, m.orderText.slice(i + token.length));
  }

  function renderMachine(m) {
    parts.model = m;
    setText(parts.status, `${m.status}${m.reason ? ` · ${m.reason}` : ''}`);
    parts.status.dataset.state = m.status.toLowerCase().replace(' ', '-');
    setText(parts.units, `${m.place} · ${m.units}`);
    renderOrderText(m);
    if (!m.processes.some(x => x.id === orderForm.processId)) orderForm.processId = m.processes[0]?.id ?? null;
    syncList(parts.process, m.processes, x => x.id, x => new Option(x.label, x.id), (o, x) => setText(o, x.label));
    parts.process.value = orderForm.processId ?? '';
    parts.process.disabled = !m.processes.length;
    refreshOrder();
    updateButton(parts.stop, m.stop);
    syncList(parts.runs, m.runs, r => r.id, () => { const li = el('li', 'sf-row'); li.append(el('div', 'sf-chart')); return li; },
      (row, r) => renderProgress(row.firstChild, r));
    setText(parts.runsEmpty, m.runs.length ? '' : 'No batches running.');
    parts.abort.hidden = !m.runs.length;
    updateButton(parts.abort, m.abort);
    parts.study.hidden = !(m.studies ?? []).length;
    syncList(parts.studies, m.studies ?? [], s => s.id, () => { const li = el('li', 'sf-row sf-row-action'); li.append(actionButton(onAction)); return li; },
      (row, s) => { updateButton(row.firstChild, s); row.firstChild.firstChild.dataset.tone = 'study'; });
  }

  // ---------------------------------------------------------------- journal (R-05, R-09)
  let query = '';

  function buildJournal() {
    const search = el('input', 'sf-search');
    search.type = 'search';
    search.placeholder = 'Search the journal';
    search.setAttribute('aria-label', 'Search the journal');
    const status = el('p', 'sf-muted');
    status.setAttribute('role', 'status');
    search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); if (parts.model) renderJournal(parts.model); });
    const sections = el('div', 'sf-journal');
    body.replaceChildren(search, status, sections);
    return { search, status, sections, model: null };
  }

  function renderJournal(m) {
    parts.model = m;
    let shown = 0, total = 0;
    syncList(parts.sections, m.sections, s => s.id, s => {
      const sec = section(s.title);
      sec.dataset.section = s.id;
      sec.append(el('ul', 'sf-journal-list'), el('p', 'sf-muted'));
      return sec;
    }, (sec, s) => {
      const entries = s.entries.filter(e => !query || e.search.includes(query));
      shown += entries.length; total += s.entries.length;
      syncList(sec.children[1], entries, e => e.id, () => {
        const li = el('li', 'sf-journal-entry');
        li.append(el('h4', 'sf-result-title'), el('div', 'sf-journal-lines'));
        return li;
      }, (li, e) => {
        setText(li.firstChild, e.title);
        syncList(li.lastChild, e.lines.map((text, i) => ({ text, i })), x => String(x.i), () => el('p', 'sf-muted'), (p, x) => setText(p, x.text));
      });
      setText(sec.lastChild, entries.length ? '' : s.entries.length ? 'No matches in this section.' : s.empty);
    });
    setText(parts.status, query ? `${shown} of ${total} entries match "${query}".` : `${total} entries.`);
  }

  const BUILD = { workbench: () => buildWorkbench(), machine: () => buildMachine(), 'facility-systems': () => buildSystems(), journal: () => buildJournal() };
  const RENDER = { workbench: m => renderWorkbench(m), machine: m => renderMachine(m), 'facility-systems': m => renderSystems(m), journal: m => renderJournal(m) };

  return {
    /** Render a workspace projection; a null model shows the reason it is unavailable. */
    render(model, notice) {
      if (!model) { kind = null; parts = null; body.replaceChildren(el('p', 'sf-muted', notice || 'This workspace is not available here.')); return; }
      if (kind !== model.kind) { kind = model.kind; parts = (BUILD[kind] ?? BUILD['facility-systems'])(); }
      (RENDER[kind] ?? RENDER['facility-systems'])(model);
    },
    reset() {
      kind = null; parts = null; selection.methodId = null; selection.samples.clear();
      orderForm.processId = null; orderForm.mode = 'count'; orderForm.count = 1;
      query = '';
    }
  };
}
