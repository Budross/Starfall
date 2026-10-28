// Power trend buffer (A-03, S-54): session-only presentation state, never saved. It keeps samples
// of COMMITTED states only — the shell pushes the observer's power sample after each committed
// transaction — at a fixed simulation-time cadence, up to a bound. Wall time running ahead of
// simulation time (a hidden tab, a suspension, a paused simulation) is marked as a gap, because
// the simulation did not advance then. A change of host starts a new trend. Pure: no DOM.

/**
 * @param sampleSeconds  simulation seconds between kept samples
 * @param limit          samples kept
 * @param gapSeconds     wall seconds beyond simulated seconds that mark a gap (and staleness)
 */
export function createTrendBuffer({ sampleSeconds, limit, gapSeconds }) {
  let points = [], gaps = [], subject = null, last = null, unavailable = false;
  const reset = () => { points = []; gaps = []; last = null; };

  return {
    /** A committed sample ({subjectId, at, reserve, capacity} datums) or null, at wall time `wall` (s). */
    push(sample, wall) {
      if (!sample) { reset(); subject = null; unavailable = true; return; }
      unavailable = false;
      if (sample.subjectId !== subject || (last && sample.at < last.at)) { reset(); subject = sample.subjectId; }
      if (last && (wall - last.wall) - (sample.at - last.at) > gapSeconds) gaps.push({ at: sample.at, seconds: Math.round((wall - last.wall) - (sample.at - last.at)) });
      last = { at: sample.at, wall };
      const point = { at: sample.at, reserve: sample.reserve.value, capacity: sample.capacity.value };
      if (!points.length || sample.at - points.at(-1).at >= sampleSeconds) points.push(point);
      else if (sample.at === points.at(-1).at) points[points.length - 1] = point;
      if (points.length > limit) points.splice(0, points.length - limit);
      const first = points[0].at;
      gaps = gaps.filter(g => g.at >= first);
    },

    /** The chart's view at wall time `wall`: {state: 'unavailable'|'empty'|'live'|'stale', points, gaps, summary}. */
    view(wall) {
      if (unavailable) return { state: 'unavailable', points: [], gaps: [], summary: 'Power is not monitored here.' };
      if (points.length < 2) return { state: 'empty', points: [...points], gaps: [], summary: 'Collecting the power trend: it appears after a few samples.' };
      const stale = last && wall - last.wall > gapSeconds;
      const a = points[0], b = points.at(-1);
      const minutes = Math.max(1, Math.round((b.at - a.at) / 60));
      const fmt = v => (Math.round(v * 10) / 10).toString();
      const summary = `Reserve over the last ${minutes} min of simulation time: from ${fmt(a.reserve)} to ${fmt(b.reserve)} U, capacity ${fmt(b.capacity)} U.` +
        (gaps.length ? ` ${gaps.length} gap${gaps.length > 1 ? 's' : ''} where the simulation did not run.` : '') +
        (stale ? ' The simulation is not running: the trend is not updating.' : '');
      return { state: stale ? 'stale' : 'live', points: [...points], gaps: [...gaps], summary };
    }
  };
}
