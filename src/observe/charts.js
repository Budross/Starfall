// Chart display data (Habitat05_02 §7). Every chart value passes through this shape,
// built from observer projections. Unknown is a status, never a zero (K-06).
const STATUSES = new Set(['observed', 'estimated', 'stale', 'unknown']);

export function datum({ subjectId, metric, value, unit, status, observedAt = null, source = null, confidence, canActOn = false }) {
  if (!STATUSES.has(status)) throw new Error(`unknown datum status ${status}`);
  if (status === 'unknown') {
    if (value !== undefined && value !== null) throw new Error('an unknown datum cannot carry a value');
    value = null;
  } else if (!Number.isFinite(value)) {
    throw new Error(`${status} datum needs a finite value`);
  }
  const d = { subjectId, metric, value, unit, status, observedAt, source, canActOn: !!canActOn };
  if (confidence !== undefined) d.confidence = confidence;
  return Object.freeze(d);
}

/** Text for a datum; unknown renders as words, never as 0. */
export function formatDatum(d) {
  if (d.status === 'unknown') return 'unknown';
  const v = `${d.value}${d.unit ? ' ' + d.unit : ''}`;
  return d.status === 'observed' ? v : `${v} (${d.status})`;
}
