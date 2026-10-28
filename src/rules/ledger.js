// World ledger (Habitat05_03 §5.3): typed history of committed semantic facts, appended
// by the causing operation inside its own transaction and stamped at the current
// simulation time. Bounded FIFO of evictable history — no authoritative fact may depend
// on an entry still being here (LG-01). Sole writer of the `ledger` slice.
import { check, isObj, isFiniteNum } from '../core/shape.js';

export const LEDGER_LIMIT = 200;
const MAX_ENTRY_BYTES = 2048;

/** Entry type → exact data keys. */
const TYPES = Object.freeze({
  WORLD_CREATED: ['seed', 'generatorRevision'],
  PLACE_OBSERVATION_CHANGED: ['placeRef', 'noticed', 'changed'],
  EVIDENCE_EXAMINED: ['subjectRef'],
  SITE_CREATED: ['siteId'],
  ENTITY_LIFECYCLE_CHANGED: ['entityId', 'from', 'to'],
  AUTHORITY_CHANGED: ['entityId', 'change'],
  // Stage 3
  VESSEL_CREATED: ['vesselId'],
  SHIP_DEPARTED: ['vesselId', 'toHostId', 'arriveAt'],
  SHIP_ARRIVED: ['vesselId', 'hostId'],
  SHIP_DOCKED: ['vesselId', 'hostId', 'berthId'],
  SHIP_DOCK_FAILED: ['vesselId', 'hostId', 'reason'],
  SHIP_UNDOCKED: ['vesselId', 'hostId', 'berthId'],
  JOURNEY_CANCELLED: ['vesselId'],
  // Stage 4
  DEPOSITS_INITIALIZED: ['nodes'],
  WORK_STARTED: ['runId', 'kind'],
  WORK_COMPLETED: ['runId', 'kind'],
  WORK_CANCELLED: ['runId', 'kind'],
  DEPOSIT_DEPLETED: ['nodeId'],
  EQUIPMENT_REPAIRED: ['bankId'],
  EXPERIMENT_PERFORMED: ['attemptId', 'methodId'],
  DISCOVERY_MADE: ['discoveryId', 'via'],
  CARGO_DISCARDED: ['holderId', 'itemId', 'qty'],
  // Industrial stage (save-schema revision 4)
  EQUIPMENT_INSTALLED: ['bankId', 'model'],
  EQUIPMENT_TOGGLED: ['bankId', 'enabled'],
  MACHINE_RUN_STARTED: ['runId', 'bankId', 'processId'],
  MACHINE_RUN_ABORTED: ['runId', 'bankId', 'lostInputs'],
  ORDER_SET: ['orderId', 'bankId', 'processId', 'mode', 'requested'],
  ORDER_STOPPED: ['orderId', 'bankId', 'completed', 'aborted'],
  ORDER_COMPLETED: ['orderId', 'bankId', 'completed', 'aborted'],
  // Stage 5 (save-schema revision 5)
  DESIGN_STUDIED: ['studyId', 'bankId', 'discoveryId']
});
export const LEDGER_TYPES = Object.freeze(Object.keys(TYPES));

export function initialLedger() { return { nextId: 1, entries: [] }; }

function jsonSafe(v, depth = 0) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (depth >= 4) return false;
  if (Array.isArray(v)) return v.length <= 16 && v.every(x => jsonSafe(x, depth + 1));
  if (isObj(v) && Object.getPrototypeOf(v) === Object.prototype) return Object.values(v).every(x => jsonSafe(x, depth + 1));
  return false;
}

function checkEntry(e) {
  check(isObj(e), 'ledger entry must be an object');
  const keys = TYPES[e.type];
  check(keys, `unknown ledger entry type ${e.type}`);
  check(Number.isSafeInteger(e.id) && e.id > 0, 'ledger entry id must be a positive integer');
  check(isFiniteNum(e.time) && e.time >= 0, 'ledger entry time must be finite');
  check(isObj(e.data), 'ledger entry data must be an object');
  const got = Object.keys(e.data).sort().join(','), want = [...keys].sort().join(',');
  check(got === want, `${e.type} data keys must be exactly [${want}], got [${got}]`);
  check(jsonSafe(e.data), `${e.type} data is not JSON-safe`);
  check(JSON.stringify(e).length <= MAX_ENTRY_BYTES, `${e.type} entry exceeds ${MAX_ENTRY_BYTES} bytes`);
}

/** Append a typed entry to the candidate's ledger. Validated at append; oldest evicted past the limit. */
export function append(candidate, type, data) {
  const ledger = candidate.ledger;
  const entry = { id: ledger.nextId, type, time: candidate.meta.simulationTime, data };
  checkEntry(entry);
  ledger.entries.push(entry);
  ledger.nextId += 1;
  if (ledger.entries.length > LEDGER_LIMIT) ledger.entries.splice(0, ledger.entries.length - LEDGER_LIMIT);
  return entry.id;
}

export function validateLedger(ledger, simulationTime) {
  check(isObj(ledger) && Array.isArray(ledger.entries), 'ledger must be {nextId, entries[]}');
  check(Number.isSafeInteger(ledger.nextId) && ledger.nextId >= 1, 'ledger.nextId must be a positive integer');
  check(ledger.entries.length <= LEDGER_LIMIT, `ledger exceeds ${LEDGER_LIMIT} entries`);
  let prevId = 0, prevTime = 0;
  for (const e of ledger.entries) {
    checkEntry(e);
    check(e.id > prevId && e.id < ledger.nextId, 'ledger ids must increase and stay below nextId');
    check(e.time >= prevTime && e.time <= simulationTime, 'ledger times must be non-decreasing and not in the future');
    prevId = e.id; prevTime = e.time;
  }
}

/** Newest-first copies, optionally filtered by type. Read-only. */
export function recent(ledger, { type, limit = LEDGER_LIMIT } = {}) {
  return ledger.entries.filter(e => !type || e.type === type).slice(-limit).reverse().map(e => structuredClone(e));
}
