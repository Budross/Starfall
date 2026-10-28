/**
 * TacticalFeedOverlay — standalone scene renderer for docking-ring / airlock scenes.
 *
 * Presentation only (Habitat05_04 §4–§5). It never docks a ship, moves a character,
 * transfers material or advances simulation time. The host passes an observer-safe
 * SceneView and receives action *requests*; the host revalidates and dispatches them.
 *
 *   const overlay = new TacticalFeedOverlay({ container, onActionRequest, onPresentationComplete, onCloseRequest });
 *   overlay.showScene(sceneView, { transition: 'full' | 'brief' | 'none' });
 *   overlay.updateScene(sceneView); overlay.skipTransition(); overlay.focus(); overlay.closeScene(); overlay.destroy();
 *
 * SceneView: { sceneId, subjectId, perspective: 'physical'|'remote-feed'|'recording', status,
 *   title, description?, freshness?, telemetry?: {key:{label, value|null, unit?, source?}},
 *   actions?: [{id, label, enabled?, reason?, group?: 'work', tone?: 'examine'|'review'|'study'}],
 *   installed?: {slots: {used, total}, rows: [{id, label, status, detail, battery, controls?: {id, label}}]},
 *   skin?: {bayLabel?, scene?, seed?} }
 * Actions with group 'work' render in a rail beside the frame, shown only when there are any.
 * Examine, Review and Study carry distinct tones (color plus their distinct labels, S-25, S-51).
 * `installed` lists the equipment in the compartment with its slots; a row's Controls button
 * is an ordinary action request (the host decides what it opens).
 * skin.scene picks a backdrop template from SceneTemplate.js (default 'docking-ring').
 *
 * Presentation states: CLOSED → ENTERING → INTERACTIVE → EXITING → CLOSED; DESTROYED is terminal.
 * The scene is modal (focus trapped) only while ENTERING; once INTERACTIVE it shares the page.
 * Animation progress is transient UI state and is never persisted.
 */

import { renderSceneBackdrop } from './SceneTemplate.js';

const SVGNS = 'http://www.w3.org/2000/svg';
let instanceCount = 0;

/** Iris geometry, in the 1000×1000 scene viewBox. */
export const IRIS = Object.freeze({ cx: 500, cy: 500, r: 258, blades: 12, closedDeg: -8, openDeg: 90 });

/** Edge angle (radians) of every blade for an opening progress 0 (closed) … 1 (open). */
export function irisEdgeAngle(progress, g = IRIS) {
  const p = Math.max(0, Math.min(1, progress));
  return (g.closedDeg + (g.openDeg - g.closedDeg) * p) * Math.PI / 180;
}

/**
 * Radius of the circle inscribed in the open aperture (≤ 0 means fully closed).
 * Each blade pivots on the rim; its inner edge sits R·sin(α) from the centre.
 */
export function irisApertureRadius(progress, g = IRIS) {
  return g.r * Math.sin(irisEdgeAngle(progress, g));
}

const rot = (v, a) => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) });

/** Pivot and inner-edge direction for blade i. */
function bladeFrame(i, progress, g) {
  const th = i * 2 * Math.PI / g.blades;
  const P = { x: g.cx + g.r * Math.sin(th), y: g.cy - g.r * Math.cos(th) };
  const u = { x: -Math.sin(th), y: Math.cos(th) };            // pivot → centre
  const a = irisEdgeAngle(progress, g);
  const e = rot(u, a);                                         // inner edge direction
  const n = rot(e, Math.PI / 2);                               // covered side
  return { P, e, n, a };
}

/**
 * Blade i as a polygon: a strip whose inner edge pivots at the rim. Width 1.2·R
 * guarantees full closure at progress 0 (see tests/iris.test.mjs).
 */
export function irisBladePolygon(i, progress, g = IRIS) {
  const { P, e, n } = bladeFrame(i, progress, g);
  const L = 2 * g.r, W = 1.2 * g.r;
  return [
    { x: P.x - e.x * L, y: P.y - e.y * L },
    { x: P.x + e.x * L, y: P.y + e.y * L },
    { x: P.x + e.x * L + n.x * W, y: P.y + e.y * L + n.y * W },
    { x: P.x - e.x * L + n.x * W, y: P.y - e.y * L + n.y * W }
  ];
}

/** Visible seam of blade i: from its pivot to the far vertex of its aperture side. */
export function irisBladeSeam(i, progress, g = IRIS) {
  const { P, e, a } = bladeFrame(i, progress, g);
  const d = g.r * Math.sin(a);
  const chord = Math.max(0, 2 * g.r * Math.cos(a));            // edge length inside the housing
  const t = Math.min(chord, Math.max(0, g.r * Math.cos(a) + Math.max(0, d) * Math.tan(Math.PI / g.blades)));
  return [P, { x: P.x + e.x * t, y: P.y + e.y * t }];
}

const EASE = {
  linear: t => t,
  outQuad: t => 1 - (1 - t) * (1 - t),
  outCubic: t => 1 - Math.pow(1 - t, 3),
  inOutQuad: t => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
};

/**
 * Bounded, data-driven beats (Doc 04 §6.3). Times in ms.
 * full  — first visit to a docking location: the whole cinematic.
 * brief — subsequent visits: quick ≈1 s animate-in, then the settled interactive state.
 * reverse — demo/undock presentation back to the sealed state.
 */
export const TIMELINES = Object.freeze({
  full: { duration: 4800, beats: [
    { beat: 'clamps', from: 1, to: 0, start: 0, end: 1000, ease: 'inOutQuad' },
    { beat: 'phase', label: 'SEAL CYCLE', start: 0 },
    { beat: 'phase', label: 'EQUALIZING', start: 800 },
    { beat: 'iris', from: 0, to: 1, start: 2000, end: 3800, ease: 'outCubic' },
    { beat: 'phase', label: 'APERTURE OPEN', start: 3000 },
    { beat: 'viewport', from: 0, to: 1, start: 3600, end: 4800, ease: 'outQuad' }
  ] },
  brief: { duration: 1000, beats: [
    { beat: 'clamps', from: 0, to: 0, start: 0, end: 0 },
    { beat: 'iris', from: .2, to: 1, start: 0, end: 600, ease: 'outCubic' },
    { beat: 'viewport', from: 0, to: 1, start: 300, end: 1000, ease: 'outQuad' }
  ] },
  reverse: { duration: 1000, beats: [
    { beat: 'viewport', from: 1, to: 0, start: 0, end: 500, ease: 'outQuad' },
    { beat: 'iris', from: 1, to: 0, start: 300, end: 900, ease: 'outCubic' },
    { beat: 'clamps', from: 0, to: 1, start: 700, end: 1000, ease: 'inOutQuad' }
  ] }
});

const FINAL = { clamps: 0, iris: 1, viewport: 1 };
const SEALED = { clamps: 1, iris: 0, viewport: 0 };

/** Evaluate a timeline at elapsed ms → {clamps, iris, viewport, phase}. Pure; exported for tests. */
export function sampleTimeline(timeline, elapsed, initial = SEALED) {
  const out = { ...initial, phase: null };
  const seen = new Set();
  for (const b of [...timeline.beats].sort((x, y) => x.start - y.start)) {
    if (b.beat === 'phase') { if (elapsed >= b.start) out.phase = b.label; continue; }
    // Before its first beat starts, a value holds that beat's starting value.
    if (elapsed < b.start) { if (!seen.has(b.beat)) out[b.beat] = b.from; seen.add(b.beat); continue; }
    seen.add(b.beat);
    const span = Math.max(0, b.end - b.start);
    const t = span ? Math.min(1, (elapsed - b.start) / span) : 1;
    out[b.beat] = b.from + (b.to - b.from) * (EASE[b.ease || 'linear'])(t);
  }
  return out;
}

function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h || 1;
}
function seededRandom(seed) {
  let a = hashSeed(seed);
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const PERSPECTIVE_LABEL = { physical: 'PHYSICALLY PRESENT', 'remote-feed': 'REMOTE FEED', recording: 'RECORDING' };

const STYLES = `
.tfo{--cyan:#70d7dd;--dim:#6b95a6;--green:#42d7a3;--gold:#f3bd65;--line:#235061;
  position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;container:tfo/inline-size;
  background:rgba(3,8,13,.88);font-family:'IBM Plex Mono','Courier New',monospace;color:#d4e9ed;
  opacity:1;transition:opacity .2s ease;box-sizing:border-box}
.tfo[hidden]{display:none}.tfo *{box-sizing:border-box}
.tfo.tfo--fade{opacity:0}
.tfo-layout{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;height:100%;min-height:0}
.tfo-frame{position:relative;flex:0 1 880px;min-width:0;height:min(85vh,760px);max-height:100%;display:flex;flex-direction:column;
  background:#050b13;border:1px solid var(--line);border-radius:4px;overflow:hidden;box-shadow:0 10px 40px #000a}
.tfo-rail{flex:0 0 220px;max-height:100%;overflow:auto;padding:12px;background:rgba(7,20,28,.94);border:1px solid var(--line);
  border-radius:4px;box-shadow:0 10px 40px #000a;transition:opacity .25s ease}
.tfo-rail[hidden]{display:none}
.tfo-rail.tfo-rail--off{opacity:0;visibility:hidden}
.tfo-rail-h{margin:0 0 10px;font-size:11px;letter-spacing:1.4px;color:var(--cyan);text-transform:uppercase}
.tfo-rail .tfo-actions{flex-direction:column;flex-wrap:nowrap}
.tfo-rail .tfo-action{max-width:none}
.tfo-rail .tfo-btn{width:100%;text-align:left}
.tfo-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px;background:#08121c;border-bottom:1px solid var(--line);font-size:11px}
.tfo-rec{width:8px;height:8px;border-radius:50%;background:#e2685f;flex:none}
.tfo-feed{font-weight:700;color:#e0f5f6;letter-spacing:.8px}
.tfo-badge{border:1px solid var(--line);padding:2px 6px;color:var(--cyan);font-size:10px;letter-spacing:1px}
.tfo-badge[data-perspective="remote-feed"],.tfo-badge[data-perspective="recording"]{color:var(--gold);border-color:#6b5a3a}
.tfo-phase{color:var(--green);min-width:8ch}
.tfo-spacer{flex:1}
.tfo-btn{font:inherit;font-size:11px;cursor:pointer;color:#a9d4df;background:#0e202a;border:1px solid #2b505e;border-radius:3px;min-height:32px;padding:6px 12px}
.tfo-btn:hover{background:#173644;border-color:#56adb7}
.tfo-btn:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
.tfo-btn:disabled{opacity:.45;cursor:not-allowed}
.tfo-btn[hidden]{display:none}
.tfo-view{position:relative;flex:1;min-height:0;background:#000}
.tfo-view svg{position:absolute;inset:0;width:100%;height:100%;display:block}
.tfo-deck{position:absolute;left:12px;right:12px;bottom:12px;max-height:55%;overflow:auto;padding:12px 14px;
  background:rgba(7,20,28,.94);border:1px solid var(--line);border-radius:4px;transform:translateY(0);transition:transform .25s ease,opacity .25s ease}
.tfo-deck[hidden]{display:block;transform:translateY(24px);opacity:0;pointer-events:none;visibility:hidden}
.tfo-title{margin:0 0 6px;font-size:15px;color:#e0fbfc;letter-spacing:.4px}
.tfo-desc{margin:0 0 8px;font-size:12px;line-height:1.6;color:#a3c2c7}
.tfo-tele{display:flex;flex-wrap:wrap;gap:6px 16px;margin:0 0 10px;font-size:11px;color:var(--dim)}
.tfo-tele div{display:flex;gap:6px}.tfo-tele dt{margin:0}.tfo-tele dd{margin:0;color:#b5dce5}
.tfo-tele dd[data-unavailable]{color:var(--gold)}
.tfo-actions{display:flex;flex-wrap:wrap;gap:8px}
.tfo-action{display:flex;flex-direction:column;gap:3px;max-width:240px}
.tfo-reason{font-size:10px;color:var(--gold);line-height:1.4}
.tfo-btn[data-tone="study"]{border-color:#7b62b8;color:#d2c2ff;background:#1b1430}
.tfo-btn[data-tone="examine"]{border-color:#a07a35;color:#f3cf8f;background:#2a1f0c}
.tfo-btn[data-tone="move"]{border-color:#6f8aa3;color:#c3d3e2;background:#152029}.tfo-btn[data-tone="move"]:hover{background:#1f2e3b}
.tfo-btn[data-tone="review"]{border-color:#3d7a5e;color:#a7e3c4;background:#0d241b}
.tfo-btn[data-tone="examine"]:hover{background:#3a2b11}.tfo-btn[data-tone="review"]:hover{background:#133426}.tfo-btn[data-tone="study"]:hover{background:#271d45}
.tfo-installed{margin:0 0 10px}
.tfo-installed[hidden]{display:none}
.tfo-inst-h{margin:0 0 6px;font-size:11px;letter-spacing:1.2px;color:var(--cyan);text-transform:uppercase}
.tfo-inst-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.tfo-inst{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;color:#b5dce5;border:1px solid transparent;border-radius:3px;padding:3px 4px}
.tfo-inst-label{color:#e0f5f6}
.tfo-inst-state{font-size:10px;letter-spacing:1px;color:var(--green);border:1px solid #2b505e;padding:1px 5px}
.tfo-inst-state[hidden]{display:none}
.tfo-inst-state[data-state="STARVED"],.tfo-inst-state[data-state="POWER LIMITED"],.tfo-inst-state[data-state="IDLE"]{color:var(--gold)}
.tfo-inst-state[data-state="OFFLINE"],.tfo-inst-state[data-state="DISABLED"]{color:#e2685f}
.tfo-inst-detail{color:var(--dim);flex:1 1 200px}
.tfo-inst .tfo-btn{min-height:26px;padding:3px 10px}
@media (max-width:640px){.tfo{padding:6px}.tfo-deck{max-height:62%}}
@container tfo (max-width:640px){
  .tfo-layout{flex-direction:column;align-items:stretch}
  .tfo-rail{flex:none;max-height:40%}
  .tfo-rail .tfo-actions{flex-direction:row;flex-wrap:wrap}
  .tfo-rail .tfo-btn{width:auto}
  .tfo-frame{flex:1 1 auto;min-height:0;height:auto}}
@media (prefers-reduced-motion:reduce){.tfo,.tfo-deck,.tfo-rail{transition:none}}
`;

export class TacticalFeedOverlay {
  constructor(options = {}) {
    this.container = options.container || document.body;
    this.soundEnabled = !!options.soundEnabled;                  // off by default (Doc 04 §8.2.8)
    this.onActionRequest = options.onActionRequest || (() => {});
    this.onPresentationComplete = options.onPresentationComplete || (() => {});
    this.onCloseRequest = options.onCloseRequest || null;        // UI-only close; null → close directly
    this.reducedMotion = options.reducedMotion ?? 'auto';        // 'auto' | true | false
    this.timelines = { ...TIMELINES, ...(options.timelines || {}) };
    this.state = 'CLOSED';
    this.view = null;
    this.pending = false;
    this._uid = `tfo${++instanceCount}`;
    this._raf = null;
    this._timers = new Set();
    this._listeners = [];
    this._resolveShown = null;
    this._returnFocus = null;
    this._audio = null;
    this._backdropSeed = null;
    injectStyles();
    this._mount();
  }

  // ---- public API -------------------------------------------------------------

  /** Present an already-authorized scene. Resolves when it settles into INTERACTIVE (or is closed). */
  showScene(view, { transition = 'full' } = {}) {
    this._assertAlive();
    this._cancelAnimation();
    const wasOpen = this.state !== 'CLOSED';
    if (!wasOpen) this._returnFocus = document.activeElement;
    this.view = view;
    this._render(view);
    this.root.hidden = false;
    this.root.classList.remove('tfo--fade');
    this.root.setAttribute('aria-modal', 'true');
    this._setDeckVisible(false);
    this.state = 'ENTERING';
    this.els.skip.hidden = false;
    const done = new Promise(res => { this._resolveShown = res; });
    const tl = this.timelines[transition];
    if (transition === 'none' || !tl || this._prefersReducedMotion()) {
      // Reduced motion: same information and actions, no motion beyond a short crossfade.
      this.root.classList.add('tfo--fade');
      this._apply(FINAL);
      this._later(() => { this.root.classList.remove('tfo--fade'); this._settle(); }, 20);
    } else {
      this._apply(SEALED);
      this._beep(660);
      this._play(tl, SEALED, () => this._settle());
    }
    this.els.skip.focus({ preventScroll: true });
    return done;
  }

  /** Replace the displayed view (e.g. after a committed state change). Preserves focused controls. */
  updateScene(view) {
    if (this.state === 'DESTROYED' || this.state === 'CLOSED') return;
    this.view = view;
    this.pending = false;
    this._render(view);
  }

  /** Clear the pending (double-submit) guard without replacing the view, e.g. after a rejected command. */
  clearPending() { this.pending = false; this._renderActions(this.view?.actions || []); this._renderInstalled(this.view?.installed || null); }

  /** Move focus into the scene: Skip while entering, else the first enabled deck action or Return to map. */
  focus() {
    if (this.state === 'ENTERING') { this.els.skip.focus({ preventScroll: true }); return; }
    if (this.state !== 'INTERACTIVE') return;
    (this.els.actions.querySelector('button:not([disabled])') || this.els.close).focus({ preventScroll: true });
  }

  /** Jump to the already-authorized end state. Changes presentation only. */
  skipTransition() {
    if (this.state === 'ENTERING') { this._cancelAnimation(); this._apply(FINAL); this._settle(); }
    else if (this.state === 'EXITING') { this._cancelAnimation(); this._finishClose(); }
  }

  /** UI-only close. Never undocks, cancels or disembarks. */
  closeScene({ transition = 'fade' } = {}) {
    if (this.state === 'CLOSED' || this.state === 'DESTROYED') return Promise.resolve();
    this._cancelAnimation();
    if (this._resolveShown) { this._resolveShown({ closed: true }); this._resolveShown = null; }
    this.state = 'EXITING';
    this._setDeckVisible(false);
    this.els.skip.hidden = true;
    return new Promise(res => {
      this._resolveClosed = res;
      const tl = this.timelines[transition];
      if (this._prefersReducedMotion() || transition === 'none') return this._finishClose();
      if (tl) return this._play(tl, FINAL, () => this._fadeOut());
      this._fadeOut();
    });
  }

  setSoundEnabled(on) { this.soundEnabled = !!on; }

  destroy() {
    if (this.state === 'DESTROYED') return;
    this._cancelAnimation();
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
    for (const off of this._listeners) off();
    this._listeners = [];
    if (this._audio) { this._audio.close?.().catch(() => {}); this._audio = null; }
    this.root.remove();
    this.state = 'DESTROYED';
    if (this._resolveShown) { this._resolveShown({ destroyed: true }); this._resolveShown = null; }
  }

  /** Demo convenience: plays the docking *presentation*. It does not dock anything. */
  dock(context = {}) {
    return this.showScene(context.view || demoView(context), { transition: context.transition || 'full' });
  }
  /** Demo convenience: plays the sealing presentation, then closes. It does not undock anything. */
  undock() { return this.closeScene({ transition: 'reverse' }); }

  // ---- internals --------------------------------------------------------------

  _assertAlive() { if (this.state === 'DESTROYED') throw new Error('TacticalFeedOverlay has been destroyed'); }

  _prefersReducedMotion() {
    if (this.reducedMotion !== 'auto') return !!this.reducedMotion;
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  _mount() {
    const id = this._uid;
    const root = document.createElement('div');
    root.className = 'tfo';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.innerHTML = `
      <div class="tfo-layout">
      <section class="tfo-rail" data-r="rail" aria-labelledby="${id}-rail-h" hidden>
        <h2 class="tfo-rail-h" id="${id}-rail-h">Work here</h2>
        <div class="tfo-actions" data-r="work" role="group" aria-label="Work actions"></div>
      </section>
      <div class="tfo-frame">
        <div class="tfo-bar">
          <span class="tfo-rec" aria-hidden="true"></span>
          <span class="tfo-feed" data-r="feed"></span>
          <span class="tfo-badge" data-r="persp"></span>
          <span class="tfo-phase" data-r="phase" aria-live="polite"></span>
          <span class="tfo-spacer"></span>
          <button type="button" class="tfo-btn" data-r="skip">Skip animation</button>
          <button type="button" class="tfo-btn" data-r="close">Return to map</button>
        </div>
        <div class="tfo-view">
          <svg viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
            <defs>
              <linearGradient id="${id}-blade" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="#3d4c5e"/><stop offset="45%" stop-color="#1b2735"/><stop offset="100%" stop-color="#4a5b6e"/>
              </linearGradient>
              <linearGradient id="${id}-blade2" x1="1" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#334253"/><stop offset="50%" stop-color="#18222f"/><stop offset="100%" stop-color="#405163"/>
              </linearGradient>
              <linearGradient id="${id}-sky" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#010309"/><stop offset="55%" stop-color="#05101c"/><stop offset="100%" stop-color="#0a1828"/>
              </linearGradient>
              <clipPath id="${id}-aperture"><circle cx="${IRIS.cx}" cy="${IRIS.cy}" r="${IRIS.r + 4}"/></clipPath>
            </defs>
            <g data-r="backdrop"></g>
            <g data-r="iris" clip-path="url(#${id}-aperture)"></g>
            <g data-r="seams" clip-path="url(#${id}-aperture)"></g>
            <path d="M 500 500 m -490 0 a 490 490 0 1 0 980 0 a 490 490 0 1 0 -980 0 M 500 500 m -${IRIS.r} 0 a ${IRIS.r} ${IRIS.r} 0 1 1 ${IRIS.r * 2} 0 a ${IRIS.r} ${IRIS.r} 0 1 1 -${IRIS.r * 2} 0"
                  fill="#0b131f" fill-rule="evenodd" stroke="#1e2b3a" stroke-width="5"/>
            <circle cx="${IRIS.cx}" cy="${IRIS.cy}" r="${IRIS.r}" fill="none" stroke="#5f7286" stroke-width="5"/>
            <g data-r="clamps"></g>
          </svg>
          <section class="tfo-deck" data-r="deck" hidden>
            <h2 class="tfo-title" data-r="title"></h2>
            <p class="tfo-desc" data-r="desc"></p>
            <dl class="tfo-tele" data-r="tele"></dl>
            <section class="tfo-installed" data-r="installed" hidden>
              <h3 class="tfo-inst-h" data-r="instH"></h3>
              <ul class="tfo-inst-list" data-r="instList"></ul>
            </section>
            <div class="tfo-actions" data-r="actions" role="group" aria-label="Available actions"></div>
          </section>
        </div>
      </div>
      </div>`;
    this.root = root;
    this.container.appendChild(root);
    this.svg = root.querySelector('svg');
    this.els = Object.fromEntries([...root.querySelectorAll('[data-r]')].map(el => [el.dataset.r, el]));
    this._buildIris();
    this._buildClamps();
    this._bind();
  }

  _buildIris() {
    const id = this._uid;
    this.blades = [];
    this.seams = [];
    for (let i = 0; i < IRIS.blades; i++) {
      const poly = document.createElementNS(SVGNS, 'polygon');
      poly.setAttribute('fill', `url(#${id}-${i % 2 ? 'blade2' : 'blade'})`);
      poly.setAttribute('stroke', '#0a0f17');
      poly.setAttribute('stroke-width', '2');
      this.els.iris.appendChild(poly);
      this.blades.push(poly);
      const seam = document.createElementNS(SVGNS, 'line');
      seam.setAttribute('stroke', '#8da2b6');
      seam.setAttribute('stroke-opacity', '.55');
      seam.setAttribute('stroke-width', '2');
      this.els.seams.appendChild(seam);
      this.seams.push(seam);
    }
  }

  _buildClamps() {
    // Real per-instance elements (not <use>), so each rod can be animated directly.
    this.rods = [];
    for (let i = 0; i < 6; i++) {
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('transform', `rotate(${i * 60} 500 500)`);
      const housing = document.createElementNS(SVGNS, 'rect');
      for (const [k, v] of Object.entries({ x: 478, y: 120, width: 44, height: 95, rx: 4, fill: '#0f1825', stroke: '#3a4a5c', 'stroke-width': 2 })) housing.setAttribute(k, v);
      const rod = document.createElementNS(SVGNS, 'rect');
      for (const [k, v] of Object.entries({ x: 488, y: 168, width: 24, height: 74, fill: '#b9c6d3', stroke: '#1e2b3a', 'stroke-width': 1.5 })) rod.setAttribute(k, v);
      const lamp = document.createElementNS(SVGNS, 'circle');
      for (const [k, v] of Object.entries({ cx: 500, cy: 140, r: 5 })) lamp.setAttribute(k, v);
      g.append(rod, housing, lamp);
      this.els.clamps.appendChild(g);
      this.rods.push({ rod, lamp });
    }
  }

  /** Rebuilds only when the scene template or seed changes, so updateScene() never redraws the room. */
  _buildBackdrop(sceneType = 'docking-ring', seed = 'default') {
    const key = `${sceneType}:${seed}`;
    if (this._backdropSeed === key) return;
    this._backdropSeed = key;
    renderSceneBackdrop({ host: this.els.backdrop, type: sceneType, uid: this._uid, rnd: seededRandom(seed) });
  }

  _bind() {
    const listen = (t, type, fn, opts) => { t.addEventListener(type, fn, opts); this._listeners.push(() => t.removeEventListener(type, fn, opts)); };
    listen(this.els.skip, 'click', () => this.skipTransition());
    listen(this.els.close, 'click', () => this._requestClose());
    const onAction = e => {
      const btn = e.target.closest('button[data-action]');
      if (!btn || btn.disabled || this.pending || this.state !== 'INTERACTIVE') return;
      // Double-submit guard: one request at a time (deck and rail together) until the host updates or clears.
      this.pending = true;
      this._renderActions(this.view?.actions || []);
      this._renderInstalled(this.view?.installed || null);
      this.onActionRequest({ sceneId: this.view?.sceneId, subjectId: this.view?.subjectId, actionId: btn.dataset.action });
    };
    listen(this.els.actions, 'click', onAction);
    listen(this.els.work, 'click', onAction);
    listen(this.els.instList, 'click', onAction);
    listen(this.root, 'keydown', e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (this.state === 'ENTERING') this.skipTransition();
        else if (this.state === 'INTERACTIVE') this._requestClose();
        return;
      }
      if (e.key === 'Tab' && this.state === 'ENTERING') this._trapFocus(e); // modal only while the transition plays
    });
    if (typeof document !== 'undefined') {
      listen(document, 'visibilitychange', () => { if (document.hidden && this.state === 'ENTERING') this.skipTransition(); });
    }
  }

  _requestClose() {
    if (this.onCloseRequest) this.onCloseRequest({ sceneId: this.view?.sceneId });
    else this.closeScene();
  }

  _trapFocus(e) {
    const items = [...this.root.querySelectorAll('button:not([disabled]):not([hidden])')]
      .filter(b => !b.closest('[inert]') && (b.offsetParent !== null || b === document.activeElement));
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  _render(view) {
    const skin = view.skin || {};
    this._buildBackdrop(skin.scene || 'docking-ring', skin.seed ?? view.subjectId ?? 'default');
    this.root.setAttribute('aria-label', view.title || 'Scene');
    this.els.feed.textContent = skin.bayLabel || 'DOCKING RING';
    const persp = view.perspective || 'physical';
    this.els.persp.dataset.perspective = persp;
    this.els.persp.textContent = (PERSPECTIVE_LABEL[persp] || persp.toUpperCase()) + (persp === 'recording' && view.freshness ? ` · ${view.freshness}` : '');
    if (this.state === 'INTERACTIVE') this.els.phase.textContent = (view.status || '').toUpperCase();
    this.els.title.textContent = view.title || '';
    this.els.desc.textContent = view.description || '';
    this.els.desc.hidden = !view.description;
    this._renderTelemetry(view.telemetry || {});
    this._renderInstalled(view.installed || null);
    this._renderActions(view.actions || []);
  }

  /** Equipment installed in this compartment, with its slots (keyed patch, so a focused Controls button survives). */
  _renderInstalled(inst) {
    const sec = this.els.installed, list = this.els.instList;
    sec.hidden = !inst || (!inst.rows.length && !inst.slots.total);
    if (sec.hidden) { list.replaceChildren(); return; }
    this.els.instH.textContent = `Installed here · slots ${inst.slots.used} of ${inst.slots.total} used`;
    const existing = new Map([...list.children].map(c => [c.dataset.key, c]));
    const wanted = new Set(inst.rows.map(r => r.id));
    for (const [key, node] of existing) if (!wanted.has(key)) node.remove();
    inst.rows.forEach((r, index) => {
      let li = existing.get(r.id);
      if (!li) {
        li = document.createElement('li');
        li.className = 'tfo-inst';
        li.dataset.key = r.id;
        const label = document.createElement('span'); label.className = 'tfo-inst-label';
        const state = document.createElement('span'); state.className = 'tfo-inst-state';
        const detail = document.createElement('span'); detail.className = 'tfo-inst-detail';
        const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'tfo-btn';
        li.append(label, state, detail, btn);
      }
      const [label, state, detail, btn] = li.children;
      label.textContent = r.label;
      state.textContent = r.status ?? '';
      state.hidden = !r.status;
      state.dataset.state = r.status ?? '';
      detail.textContent = r.detail;
      if (r.battery) li.dataset.cueTarget = 'battery'; else delete li.dataset.cueTarget;
      btn.hidden = !r.controls;
      if (r.controls) { btn.textContent = r.controls.label; btn.dataset.action = r.controls.id; btn.setAttribute('aria-label', `${r.controls.label}: ${r.label}`); btn.disabled = this.pending; }
      else delete btn.dataset.action;
      if (list.children[index] !== li) list.insertBefore(li, list.children[index] || null);
    });
  }

  _renderTelemetry(tele) {
    const dl = this.els.tele;
    dl.replaceChildren();
    for (const [key, item] of Object.entries(tele)) {
      const row = document.createElement('div');
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = (item.label || key).toUpperCase();
      // Never manufacture telemetry: absent values are shown as unavailable (Doc 04 §5.1, §8.2.10).
      if (item.value === null || item.value === undefined) { dd.textContent = 'READOUT UNAVAILABLE'; dd.dataset.unavailable = ''; }
      else dd.textContent = `${item.value}${item.unit ? ' ' + item.unit : ''}${item.source && item.source !== 'current' ? ` (${item.source})` : ''}`;
      row.append(dt, dd);
      dl.appendChild(row);
    }
    dl.hidden = !dl.children.length;
  }

  /** Work actions go to the rail (shown only when there are any); everything else to the deck. */
  _renderActions(actions) {
    const work = actions.filter(a => a.group === 'work');
    this._patchActions(this.els.actions, actions.filter(a => a.group !== 'work'), 'deck');
    this._patchActions(this.els.work, work, 'work');
    this.els.rail.hidden = !work.length;
  }

  /** Keyed patch so a focused button survives updates (UX audit U3 lesson). */
  _patchActions(host, actions, part) {
    const existing = new Map([...host.children].map(c => [c.dataset.key, c]));
    const keep = new Set();
    const wanted = new Set(actions.map(a => a.id));
    for (const [key, node] of existing) if (!wanted.has(key)) node.remove(); // drop stale rows first so indices stay stable
    actions.forEach((a, index) => {
      let wrap = existing.get(a.id);
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'tfo-action';
        wrap.dataset.key = a.id;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tfo-btn';
        btn.dataset.action = a.id;
        const reason = document.createElement('span');
        reason.className = 'tfo-reason';
        reason.id = `${this._uid}-reason-${part}-${index}-${a.id.replace(/[^\w-]/g, '_')}`;
        wrap.append(btn, reason);
      }
      const btn = wrap.firstChild, reason = wrap.lastChild;
      btn.textContent = a.label;
      if (a.tone) btn.dataset.tone = a.tone; else delete btn.dataset.tone;
      btn.disabled = a.enabled === false || this.pending;
      btn.setAttribute('aria-busy', String(this.pending));
      reason.textContent = a.enabled === false && a.reason ? a.reason : '';
      reason.hidden = !reason.textContent;
      if (reason.textContent) btn.setAttribute('aria-describedby', reason.id); else btn.removeAttribute('aria-describedby');
      // Move only when out of order: re-inserting a node that holds focus would blur it.
      if (host.children[index] !== wrap) host.insertBefore(wrap, host.children[index] || null);
      keep.add(a.id);
    });
    for (const [key, node] of existing) if (!keep.has(key)) node.remove();
  }

  _setDeckVisible(on) {
    this.els.deck.hidden = !on;
    this.els.deck.inert = !on;
    this.els.rail.inert = !on;
    this.els.rail.classList.toggle('tfo-rail--off', !on); // keeps its space, so the frame never shifts on settle
  }

  _settle() {
    if (this.state !== 'ENTERING') return;
    this.state = 'INTERACTIVE';
    this.root.setAttribute('aria-modal', 'false');
    this.els.skip.hidden = true;
    this.els.phase.textContent = (this.view?.status || '').toUpperCase();
    this._setDeckVisible(true);
    this.focus();
    this.onPresentationComplete({ sceneId: this.view?.sceneId });
    if (this._resolveShown) { this._resolveShown({ settled: true }); this._resolveShown = null; }
  }

  _fadeOut() {
    if (this._prefersReducedMotion()) return this._finishClose();
    this.root.classList.add('tfo--fade');
    this._later(() => this._finishClose(), 200);
  }

  _finishClose() {
    if (this.state !== 'EXITING') return;
    this.root.hidden = true;
    this.root.classList.remove('tfo--fade');
    this.state = 'CLOSED';
    this.pending = false;
    const back = this._returnFocus;
    this._returnFocus = null;
    if (back && back.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
    if (this._resolveClosed) { this._resolveClosed(); this._resolveClosed = null; }
  }

  _play(timeline, initial, onDone) {
    const start = performance.now();
    let lastPhase = null;
    const frame = now => {
      const elapsed = now - start;
      const s = sampleTimeline(timeline, elapsed, initial);
      this._apply(s);
      if (s.phase && s.phase !== lastPhase) { lastPhase = s.phase; this.els.phase.textContent = s.phase; this._beep(520); }
      if (elapsed >= timeline.duration) { this._raf = null; onDone(); return; }
      this._raf = requestAnimationFrame(frame);
    };
    this._raf = requestAnimationFrame(frame);
  }

  _apply({ clamps, iris, viewport }) {
    for (let i = 0; i < this.blades.length; i++) {
      this.blades[i].setAttribute('points', irisBladePolygon(i, iris).map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
      const [a, b] = irisBladeSeam(i, iris);
      this.seams[i].setAttribute('x1', a.x.toFixed(1)); this.seams[i].setAttribute('y1', a.y.toFixed(1));
      this.seams[i].setAttribute('x2', b.x.toFixed(1)); this.seams[i].setAttribute('y2', b.y.toFixed(1));
    }
    const travel = 26 * clamps;
    for (const { rod, lamp } of this.rods) {
      rod.setAttribute('transform', `translate(0 ${travel.toFixed(1)})`);
      lamp.setAttribute('fill', clamps > .05 ? '#e2685f' : '#42d7a3');
    }
    const z = 240 * viewport;
    this.svg.setAttribute('viewBox', `${z.toFixed(1)} ${z.toFixed(1)} ${(1000 - 2 * z).toFixed(1)} ${(1000 - 2 * z).toFixed(1)}`);
  }

  _cancelAnimation() { if (this._raf) cancelAnimationFrame(this._raf); this._raf = null; }

  _later(fn, ms) { const t = setTimeout(() => { this._timers.delete(t); fn(); }, ms); this._timers.add(t); }

  _beep(freq = 880, duration = .05) {
    if (!this.soundEnabled) return;
    try {
      if (!this._audio) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; this._audio = new AC(); }
      if (this._audio.state === 'suspended') this._audio.resume().catch(() => {});
      const osc = this._audio.createOscillator(), gain = this._audio.createGain(), t = this._audio.currentTime;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(.035, t);
      gain.gain.exponentialRampToValueAtTime(.0001, t + duration);
      osc.connect(gain); gain.connect(this._audio.destination);
      osc.start(); osc.stop(t + duration);
    } catch { /* audio is optional decoration */ }
  }
}

function injectStyles() {
  if (typeof document === 'undefined' || document.getElementById('tfo-styles')) return;
  const style = document.createElement('style');
  style.id = 'tfo-styles';
  style.textContent = STYLES;
  document.head.appendChild(style);
}

/** Inert demonstration view for standalone previews. Not game data. */
export function demoView(context = {}) {
  return {
    sceneId: 'demo-airlock',
    subjectId: context.subjectId || 'demo-station',
    perspective: context.perspective || 'physical',
    status: 'docked · demo',
    title: context.title || 'Demo station — docking ring',
    description: 'Demonstration data. The outer seal disengages; the service corridor is quiet.',
    telemetry: { seal: { label: 'Seal', value: 'secured', source: 'demo' }, pressure: { label: 'Pressure', value: null } },
    actions: [
      { id: 'demo-inspect', label: 'Inspect terminal', enabled: true },
      { id: 'demo-enter', label: 'Enter station', enabled: false, reason: 'Demo only: no simulation connected.' }
    ],
    skin: { bayLabel: context.bayLabel || 'OPTICAL FEED // BAY 04A', seed: context.seed || 'demo' }
  };
}
