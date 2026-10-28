// Simulation integrator (rev 3 §I). One clock owner, no idle branch: every advance steps
// through the same boundary loop, so a boundary's timestamp never depends on how the
// elapsed time was split or on unrelated activity (V-01, WK-01, fixes B03/PF-03).
//
//   repeat: next = min(end, earliest arrival, earliest run completion, earliest reserve boundary)
//           1. integrate reserves over the step at its fixed allocation (snap exactly at a boundary)
//           2. snap the clock to next (absolute, no float residue)
//           3. complete every run due at next (run order) — its energy was supplied through next —
//              record qualifying study operations (Research), and count the completed batches
//              against their orders
//           4. settle facilities: reconcile power, admit order batches one at a time, each judged
//              against the updated candidate (Work re-anchors changed speeds)
//           5. settle arrivals (vessel order), then dockOnArrival
//   until end.
//
// After step 4 every remaining boundary is strictly later (every admitted batch has positive
// work and speed), so no instant can repeat; a boundary the clock cannot pass still throws,
// which pauses simulation (T-06).
import { check } from '../core/shape.js';
import { advanceClockTo } from '../core/state.js';
import { nextArrival, settleArrivals } from '../domain/vessels.js';
import { nextCompletion, completeDueRuns, applyAllocation, admitMachineRun } from '../domain/work.js';
import { nextPowerBoundary, advancePower, allocation } from '../domain/power.js';
import { nextAdmission, recordCompletions } from '../domain/orders.js';
import { recordStudyOperations } from '../domain/research.js';

const MAX_STEPS = 10_000;

/**
 * Make every accepted run's speed equal Power's allocation for the current state. Power
 * computes; Work writes (PW-03).
 */
export function settleAllocation(candidate, ctx) {
  applyAllocation(candidate, allocation(candidate, ctx.geography, ctx.content));
}

/**
 * Facility settlement, once per transaction: after every command (runtime) and at every
 * boundary (integrator). Deterministic and single-pass per admission:
 *   1. reconcile power for the candidate as it stands (Power computes, Work writes speeds);
 *   2. ask Orders for the next batch to admit — the first unsatisfied order, in order-id order,
 *      whose machine can take a batch judged against the CURRENT candidate (units online,
 *      Power's query with the batch joined, stock, claims and reserved space);
 *   3. admit it (Work withdraws inputs, records the claim and reserved output), then go to 1.
 * It ends when no order can admit. Each admission takes a free online unit, so the loop is
 * bounded by the installed units; the guard turns any violation into a failed transaction.
 */
export function settleFacilities(candidate, ctx) {
  const ctxFull = { ...ctx, actorId: ctx.actorId ?? null };
  const units = Object.values(candidate.equipment?.banks ?? {}).reduce((n, b) => n + b.quantity, 0);
  for (let i = 0; i <= units; i++) {
    settleAllocation(candidate, ctxFull);
    const next = nextAdmission(candidate, ctxFull);
    if (!next) return;
    admitMachineRun(candidate, ctxFull, next);
  }
  throw new Error('facility settlement admitted more batches than installed units');
}

/**
 * Advance the candidate by dt through every boundary. Returns every run completed on the way,
 * across all internal boundaries ([{runId, run}], in completion order), for the transaction's
 * knowledge notice.
 */
export function advance(candidate, dt, ctx) {
  check(Number.isFinite(dt) && dt > 0, 'clock must advance by a positive finite amount');
  const completed = [];
  const start = candidate.meta.simulationTime;
  const end = start + dt;
  check(Number.isFinite(end), 'simulation time would overflow');
  for (let step = 0; step < MAX_STEPS; step++) {
    const now = candidate.meta.simulationTime;
    const power = nextPowerBoundary(candidate, ctx.geography, ctx.content);
    const next = Math.min(end, nextArrival(candidate), nextCompletion(candidate), power.t);
    // A pending boundary at or before now can never be passed: refuse rather than stall.
    check(next > now || next === end, 'the authoritative clock cannot advance past a boundary');
    advancePower(candidate, ctx.geography, ctx.content, next - now, next === power.t ? power.hosts : []);
    advanceClockTo(candidate, next);
    const done = completeDueRuns(candidate);
    recordStudyOperations(candidate, ctx, done);
    recordCompletions(candidate, done);
    completed.push(...done);
    settleFacilities(candidate, ctx);
    settleArrivals(candidate, ctx);
    if (next === end) return completed;
  }
  throw new Error('integrator exceeded its step limit');
}
