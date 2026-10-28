// Simulation scheduler (S-01, S-20, S-29). A timer wrapper, not a second clock: it only
// measures wall time and calls tick(dt) once per timer fire. All simulation time is
// advanced by the integrator inside that one transaction.
//
//   • 2 Hz while the tab is visible; stopped while hidden.
//   • A late fire while visible catches up, bounded: dt = min(wall elapsed, maxCatchUp).
//     Wall time beyond the bound is dropped (simulation runs slower, never jumps).
//   • A gap over suspendAfter (S-29, changed 2026-10-25: 30 s) is suspension the visibility
//     events missed, e.g. computer sleep with the tab still "visible": it is discarded
//     entirely — no tick, and the reference resets.
//   • No hidden-tab or offline catch-up: on return to visible the reference resets, so the
//     first dt excludes the hidden period.
//
// Dependencies are injectable for tests: doc ({visibilityState, add/removeEventListener}),
// now() in ms, and timers ({setInterval, clearInterval}).
export function createScheduler({
  tick, onTicked = () => {}, intervalMs = 500, maxCatchUp, suspendAfter,
  doc = globalThis.document, now = () => performance.now(),
  timers = { setInterval: (f, ms) => setInterval(f, ms), clearInterval: h => clearInterval(h) }
}) {
  if (!(maxCatchUp > 0)) throw new Error('scheduler needs a positive maxCatchUp');
  if (!(suspendAfter >= maxCatchUp)) throw new Error('scheduler needs a suspendAfter of at least maxCatchUp');
  let handle = null, last = 0, running = false;

  function fire() {
    const t = now();
    const gap = (t - last) / 1000;
    last = t;
    if (gap > suspendAfter) return;              // suspension: discard, never catch up
    const dt = Math.min(gap, maxCatchUp);
    if (!(dt > 0)) return;
    let result;
    try { result = tick(dt); } catch (e) { result = { ok: false, error: e.message }; }
    try { onTicked(result); } catch (e) { console.error('render after tick failed', e); } // render errors never stop the scheduler
  }

  function sync() {
    const want = running && doc.visibilityState === 'visible';
    if (want && handle === null) { last = now(); handle = timers.setInterval(fire, intervalMs); }
    else if (!want && handle !== null) { timers.clearInterval(handle); handle = null; }
  }

  return {
    start() { if (running) return; running = true; doc.addEventListener('visibilitychange', sync); sync(); },
    stop() { if (!running) return; running = false; sync(); doc.removeEventListener('visibilitychange', sync); },
    get running() { return handle !== null; }
  };
}
