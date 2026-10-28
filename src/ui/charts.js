// Small read-only graphics for workspaces and the HUD (Habitat05_02 §6, §9.1): a power strip,
// a storage bar and a progress bar. They draw observer projections only — values arrive as
// datums from observe/ — and never compute gameplay (A-01). Every graphic carries a text
// summary for screen readers (A-07) and pairs color with labels and patterns (A-08).

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const pct = (v, max) => `${Math.max(0, Math.min(100, max > 0 ? (v / max) * 100 : 0)).toFixed(1)}%`;
const fmt = (v, digits = 2) => (Math.round(v * 10 ** digits) / 10 ** digits).toFixed(digits);

function skeleton(host, cls, build) {
  if (host.dataset.chart !== cls) { host.replaceChildren(); host.dataset.chart = cls; build(); }
  return host;
}

/**
 * Power strip: supply against demand, and the reserve. Mandatory shortfall is drawn hatched
 * and labelled; it is never shown as a reserve withdrawal.
 */
export function renderPowerStrip(host, power) {
  if (!power) { host.replaceChildren(el('p', 'sf-muted', 'Power is not monitored here.')); delete host.dataset.chart; return; }
  skeleton(host, 'power', () => {
    host.append(
      el('p', 'sf-chart-summary'),
      el('div', 'sf-k', 'SUPPLY · DEMAND'),
      Object.assign(el('div', 'sf-bars'), { innerHTML: '<div class="sf-bar" data-b="supply"><span class="sf-fill sf-fill-gen"></span><span class="sf-bar-label"></span></div><div class="sf-bar" data-b="demand"><span class="sf-fill sf-fill-mand"></span><span class="sf-fill sf-fill-base"></span><span class="sf-fill sf-fill-proc"></span><span class="sf-fill sf-fill-short"></span><span class="sf-bar-label"></span></div>' }),
      el('div', 'sf-k', 'RESERVE'),
      Object.assign(el('div', 'sf-bar'), { innerHTML: '<span class="sf-fill sf-fill-reserve"></span><span class="sf-bar-label"></span>' })
    );
  });
  const [summary, , bars, , reserveBar] = host.children;
  const gen = power.generation.value, mand = power.mandatory.value, proc = power.process.value, short = power.shortfall.value;
  const base = power.baseline?.value ?? 0;
  const scale = Math.max(gen, mand + base + proc, 0.0001);
  const supply = bars.querySelector('[data-b="supply"]'), demand = bars.querySelector('[data-b="demand"]');
  supply.querySelector('.sf-fill-gen').style.width = pct(gen, scale);
  supply.querySelector('.sf-bar-label').textContent = `Generation ${fmt(gen)} ${power.generation.unit}`;
  const served = mand - short;
  demand.querySelector('.sf-fill-mand').style.width = pct(served, scale);
  demand.querySelector('.sf-fill-base').style.width = pct(base, scale);
  demand.querySelector('.sf-fill-proc').style.width = pct(proc, scale);
  demand.querySelector('.sf-fill-short').style.width = pct(short, scale);
  demand.querySelector('.sf-bar-label').textContent = `${power.mandatoryLabel} ${fmt(mand)} U/s${base ? ` · standby ${fmt(base)} U/s` : ''}${proc ? ` · work ${fmt(proc)} U/s` : ''}${short > 0 ? ` · short ${fmt(short)} U/s` : ''}`;
  reserveBar.querySelector('.sf-fill-reserve').style.width = pct(power.reserve.value, power.capacity.value);
  reserveBar.querySelector('.sf-bar-label').textContent = `${fmt(power.reserve.value, 1)} / ${fmt(power.capacity.value, 0)} U · ${power.word}`;
  host.dataset.state = power.status;
  const eta = power.secondsToEmpty !== null ? ` About ${Math.ceil(power.secondsToEmpty / 60)} min until the reserve is empty.` : '';
  summary.textContent = power.status === 'brownout'
    ? `Brownout. Generation ${fmt(gen)} U/s cannot cover ${power.mandatoryLabel.toLowerCase()} (${fmt(mand)} U/s): ${fmt(short)} U/s short. The reserve is empty; work that needs power is paused.`
    : `Generation ${fmt(gen)} U/s against ${power.mandatoryLabel.toLowerCase()} ${fmt(mand)} U/s${base ? `, machine standby ${fmt(base)} U/s` : ''}${proc ? ` and work ${fmt(proc)} U/s` : ''}. Reserve ${fmt(power.reserve.value, 1)} of ${fmt(power.capacity.value, 0)} U, ${power.word}${power.reserveRate.value ? ` at ${power.reserveRate.value > 0 ? '+' : '−'}${fmt(Math.abs(power.reserveRate.value))} U/s` : ''}.${eta}${power.curtailed.value > 0 ? ` Surplus ${fmt(power.curtailed.value)} U/s is unused.` : ''}`;
  host.setAttribute('role', 'img');
  host.setAttribute('aria-label', summary.textContent);
}

/** Storage bar: ordinary cargo and reserved output against hold capacity (A-05). */
export function renderStorageBar(host, storage) {
  skeleton(host, 'storage', () => {
    host.append(el('p', 'sf-chart-summary'), Object.assign(el('div', 'sf-bar'), { innerHTML: '<span class="sf-fill sf-fill-cargo"></span><span class="sf-fill sf-fill-reserved"></span><span class="sf-bar-label"></span>' }));
  });
  const [summary, bar] = host.children;
  const scale = Math.max(storage.capacity, storage.used + storage.reserved, 0.0001);
  bar.querySelector('.sf-fill-cargo').style.width = pct(storage.used, scale);
  bar.querySelector('.sf-fill-reserved').style.width = pct(storage.reserved, scale);
  bar.querySelector('.sf-bar-label').textContent = `${storage.used} / ${storage.capacity} m³${storage.reserved ? ` · ${storage.reserved} m³ reserved` : ''}${storage.overloaded ? ' · OVERLOADED' : ''}`;
  host.dataset.state = storage.overloaded ? 'overloaded' : 'ok';
  summary.textContent = storage.summary;
  host.setAttribute('role', 'img');
  host.setAttribute('aria-label', storage.summary);
}

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => { const n = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); return n; };

/**
 * Power trend (A-03): the reserve over recent simulation time, with the capacity as a dashed
 * line and hatched, labelled marks where the simulation did not run. Values come from committed
 * samples of powerStatus; explicit empty, stale and unavailable states (A-07).
 */
export function renderTrend(host, trend) {
  skeleton(host, 'trend', () => {
    host.append(el('div', 'sf-k', 'RESERVE TREND · U over simulation time'), el('p', 'sf-chart-summary'), el('div', 'sf-trend-plot'));
  });
  const [, summary, plot] = host.children;
  host.dataset.state = trend.state;
  summary.textContent = trend.summary;
  host.setAttribute('role', 'img');
  host.setAttribute('aria-label', trend.summary);
  if (trend.state === 'empty' || trend.state === 'unavailable') { plot.replaceChildren(); return; }
  const W = 280, H = 72, PAD = { l: 30, r: 6, t: 6, b: 16 };
  const pts = trend.points, t0 = pts[0].at, t1 = pts.at(-1).at, span = Math.max(1, t1 - t0);
  const top = Math.max(...pts.map(p => p.capacity), ...pts.map(p => p.reserve), 1);
  const x = t => PAD.l + ((t - t0) / span) * (W - PAD.l - PAD.r);
  const y = v => PAD.t + (1 - v / top) * (H - PAD.t - PAD.b);
  const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'sf-trend', 'aria-hidden': 'true', focusable: 'false' });
  const defs = svg('defs'), pattern = svg('pattern', { id: 'sf-trend-hatch', width: 4, height: 4, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
  pattern.append(svg('line', { x1: 0, y1: 0, x2: 0, y2: 4, class: 'sf-trend-hatch' }));
  defs.append(pattern);
  g.append(defs);
  g.append(svg('line', { x1: PAD.l, y1: y(0), x2: W - PAD.r, y2: y(0), class: 'sf-trend-axis' }));
  const cap = svg('polyline', { points: pts.map(p => `${x(p.at).toFixed(1)},${y(p.capacity).toFixed(1)}`).join(' '), class: 'sf-trend-capacity' });
  const line = svg('polyline', { points: pts.map(p => `${x(p.at).toFixed(1)},${y(p.reserve).toFixed(1)}`).join(' '), class: 'sf-trend-reserve' });
  g.append(cap, line);
  for (const gap of trend.gaps) {
    const gx = x(gap.at);
    g.append(svg('rect', { x: (gx - 3).toFixed(1), y: PAD.t, width: 6, height: H - PAD.t - PAD.b, fill: 'url(#sf-trend-hatch)', class: 'sf-trend-gap' }));
  }
  const label = (text, attrs) => { const n = svg('text', attrs); n.textContent = text; g.append(n); };
  label(`${Math.round(top)} U`, { x: 2, y: PAD.t + 8, class: 'sf-trend-label' });
  label('0', { x: 2, y: y(0), class: 'sf-trend-label' });
  label(`${Math.round(span / 60) || '<1'} min ago`, { x: PAD.l, y: H - 3, class: 'sf-trend-label' });
  label('now', { x: W - PAD.r - 18, y: H - 3, class: 'sf-trend-label' });
  if (trend.gaps.length) label('▨ not running', { x: W / 2 - 24, y: H - 3, class: 'sf-trend-label' });
  plot.replaceChildren(g);
}

/** Progress bar for the character's accepted work; paused and slowed are labelled, not only colored. */
export function renderProgress(host, work) {
  if (!work) { host.replaceChildren(el('p', 'sf-muted', 'No work in progress.')); delete host.dataset.chart; return; }
  skeleton(host, 'progress', () => {
    host.append(Object.assign(el('div', 'sf-bar sf-progress'), { innerHTML: '<span class="sf-fill sf-fill-work"></span><span class="sf-bar-label"></span>' }));
  });
  const bar = host.firstChild;
  bar.querySelector('.sf-fill-work').style.width = pct(work.fraction, 1);
  const status = work.paused ? 'paused: no power' : work.slowed ? 'slowed: limited power' : work.secondsLeft !== null ? `${work.secondsLeft} s left` : '';
  bar.querySelector('.sf-bar-label').textContent = `${work.label} · ${Math.round(work.fraction * 100)} %${status ? ` · ${status}` : ''}`;
  host.dataset.state = work.paused ? 'paused' : work.slowed ? 'slowed' : 'running';
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-valuenow', String(Math.round(work.fraction * 100)));
  bar.setAttribute('aria-valuetext', bar.querySelector('.sf-bar-label').textContent);
}
