// Accepted work (I-13). Sole writer of the `work` slice.
//
//   work{runs{runId:{kind, origin, actorId, issuedBy, hostId, placeId, bankId, processId, orderId,
//                    startedAt, duration, remaining, anchorAt, speed, powerRate, inputs, outputs, claim}}}
//
//   manual runs   origin 'manual', actor = the character: collect · fabricate · assemble
//   machine runs  origin 'machine', actorId null, at a bank: extract · refine (admitted from an order)
//
// `issuedBy` is the run's provenance (S-51): the principal who started it (manual) or who gave
// the order that admitted it (machine). It stays with the run when the order is stopped.
//
// `duration` is the run's full-speed work seconds; `remaining` is full-speed work seconds as of
// `anchorAt`. While speed > 0 a run ends at the absolute time anchorAt + remaining/speed, so
// completion never depends on how ticks were split (WK-01). Speed is written only by
// applyAllocation from domain/power's allocation; a run re-anchors only when its speed changes.
// A shortage interrupts work, never invalidates it: inputs, claim, reserved output and progress
// all persist (PW-02). Output volume is reserved when a run starts, so completion always fits.
//
// The personal-work lease is derived: an accepted run whose actor is the character. It blocks
// movement and other hands-on work, never reading, inspection, the map or workspaces (I-05).
// Machine runs have no actor, so they never block the character.
import { check, isObj, isSafeId, isFiniteNum, has, CommandError } from '../core/shape.js';
import { allocateId, requireSlice } from '../core/state.js';
import { authoredSite, siteOf, conditionHolds } from './world.js';
import { claimable, admissionReason, volumeOfItems, heldQty, withdraw, deliver, depleteNode, formatQty } from './inventory.js';
import { capabilitiesAt, bankLabel, isOperational } from './equipment.js';
import { allocation, powerStatus, runOrder } from './power.js';
import { append } from '../rules/ledger.js';
import { permissionReason } from '../rules/authority.js';

export const MANUAL_KINDS = Object.freeze(['collect', 'fabricate', 'assemble']);
export const MACHINE_KINDS = Object.freeze(['extract', 'refine']);

export const endsAt = r => (r.speed > 0 ? r.anchorAt + r.remaining / r.speed : Infinity);
export const remainingAt = (r, t) => r.remaining - (t - r.anchorAt) * r.speed;

/** The character's accepted run (the personal-work lease), or null. */
export function leaseOf(state, actorId) {
  for (const [runId, r] of Object.entries(state.work?.runs ?? {})) if (r.actorId === actorId) return { runId, run: r };
  return null;
}

/** Accepted runs at a bank, in run order: [[runId, run]]. */
export const runsAtBank = (state, bankId) => runOrder(state.work?.runs ?? {}).filter(id => state.work.runs[id].bankId === bankId).map(id => [id, state.work.runs[id]]);

/** Earliest completion of a running run, or Infinity. */
export function nextCompletion(state) {
  let t = Infinity;
  for (const r of Object.values(state.work?.runs ?? {})) { const e = endsAt(r); if (e < t) t = e; }
  return t;
}

/** A short label for a run (content-derived; display only). */
export function runLabel(state, content, run) {
  const out = content.items[Object.keys(run.outputs)[0]]?.label.toLowerCase();
  if (run.kind === 'collect') return `Collecting ${out}`;
  if (run.kind === 'fabricate') return `Fabricating ${out}`;
  if (run.kind === 'assemble') return `Assembling ${out}`;
  const bank = state.equipment?.banks?.[run.bankId];
  return content.equipment[bank?.model]?.processes?.[run.processId]?.label ?? 'Machine work';
}

// ---------------------------------------------------------------- manual work: shared preflight (preview = execution)

const fail = (category, reason) => ({ ok: false, category, reason });

function common(state, ctx) {
  const a = state.actor;
  const lease = leaseOf(state, ctx.actorId);
  if (lease) return fail('timing', `You are already busy: ${runLabel(state, ctx.content, lease.run).toLowerCase()}. Finish or cancel it first.`);
  const denied = permissionReason(state, ctx.actorId, a.hostId, 'useFacilities');
  if (denied) return fail('access', denied);
  return null;
}

const placeLabel = (state, content, hostId, placeId) => (authoredSite(state, content, hostId)?.places?.[placeId]?.label ?? 'compartment').toLowerCase();

/** The operation a recipe performs, from its output category: component → fabricate, product → assemble. */
export const craftKind = (content, recipe) => content.items[recipe.output].category === 'product' ? 'assemble' : 'fabricate';

/**
 * Whether a manual task can start now, and exactly what it would do. Pure; shared by the
 * observer's previews and by execution (one answer per question, PF-10).
 *   request: {kind:'collect', itemId} | {kind:'craft', recipeId}
 * Nothing made by hand or at a workbench draws power (S-32). Making is one at a time.
 * Returns {ok, category?, reason?, preview?:{kind, processId, inputs, outputs, duration, powerRate, claim}}.
 */
export function preflightWork(state, ctx, request) {
  const { content } = ctx;
  const { hostId, placeId } = state.actor;
  const site = authoredSite(state, content, hostId);
  let inputs = {}, outputs = {}, duration, claim = null, kind, processId = null;
  const blocked = common(state, ctx);
  if (blocked) return blocked;

  if (request.kind === 'collect') {
    const dep = site?.deposits?.[request.itemId];
    if (!dep?.collect) return fail('request', 'There is nothing like that to collect here.');
    if (dep.placeKey !== placeId) return fail('access', `You need to be in the ${placeLabel(state, content, hostId, dep.placeKey)} to collect that.`);
    const nodeId = `${state.entities[hostId].authoredId}.${request.itemId}`;
    const available = claimable(state, nodeId);
    if (!(available > 0)) return fail('materials', `Nothing more can be collected from the ${dep.label ?? 'deposit'}: it is depleted.`);
    const qty = Math.min(dep.collect.amount, available);
    outputs = { [request.itemId]: qty };
    claim = { nodeId, qty };
    duration = dep.collect.duration;
    kind = 'collect';
  } else if (request.kind === 'craft') {
    const recipe = has(content.recipes, request.recipeId) ? content.recipes[request.recipeId] : null;
    if (!recipe || !conditionHolds(state, ctx.geography, content, recipe.unlock, 'unlock')) return fail('request', 'That action is not available.');
    if (recipe.tool !== null && !capabilitiesAt(state, content, hostId, placeId).has(recipe.tool)) return fail('access', 'Requires suitable operational equipment in this compartment.');
    for (const slot of recipe.inputs) {
      const options = slot.item ? [slot.item] : slot.anyOf;
      const pick = options.find(id => heldQty(state, hostId, id) - (inputs[id] ?? 0) >= slot.qty);
      if (!pick) return fail('materials', `Needs ${formatQty(content, options[0], slot.qty)} of ${options.map(id => content.items[id].label.toLowerCase()).join(' or ')}.`);
      inputs[pick] = (inputs[pick] ?? 0) + slot.qty;
    }
    outputs = { [recipe.output]: recipe.qty };
    duration = recipe.duration;
    kind = craftKind(content, recipe);
    processId = request.recipeId;
  } else {
    return fail('request', 'That action is not available.');
  }

  const delta = Object.fromEntries(Object.entries(inputs).map(([id, q]) => [id, -q]));
  const space = admissionReason(state, content, hostId, delta, volumeOfItems(content, outputs));
  if (space) return fail('storage', space);
  return { ok: true, preview: { kind, processId, inputs, outputs, duration, powerRate: 0, claim } };
}

/** Start an accepted manual run. The runtime settles allocation in the same transaction. */
export function startWork(candidate, ctx, request) {
  const p = preflightWork(candidate, ctx, request);
  if (!p.ok) throw new CommandError(p.reason, p.category);
  const { hostId, placeId } = candidate.actor;
  const now = candidate.meta.simulationTime;
  const runId = allocateId(candidate, 'run');
  withdraw(candidate, hostId, p.preview.inputs);
  candidate.work.runs[runId] = {
    kind: p.preview.kind, origin: 'manual', actorId: ctx.actorId, issuedBy: ctx.actorId, hostId, placeId, bankId: null, processId: p.preview.processId, orderId: null,
    startedAt: now, duration: p.preview.duration, remaining: p.preview.duration, anchorAt: now, speed: 1, powerRate: 0,
    inputs: p.preview.inputs, outputs: p.preview.outputs, claim: p.preview.claim
  };
  append(candidate, 'WORK_STARTED', { runId, kind: p.preview.kind });
  const r = candidate.work.runs[runId];
  return { kind: 'WORK_STARTED', message: `${runLabel(candidate, ctx.content, r)} · ${p.preview.duration} s.`, changes: { runs: [runId] } };
}

/** Cancel the character's run (S-13): inputs return, the claim is released, no output. */
export function cancelWork(candidate, ctx, { runId }) {
  const r = candidate.work.runs[runId];
  if (!r || r.actorId !== ctx.actorId) throw new CommandError('There is no such work to cancel.', 'request');
  const label = runLabel(candidate, ctx.content, r);
  delete candidate.work.runs[runId];
  if (Object.keys(r.inputs).length) deliver(candidate, r.hostId, r.inputs);
  append(candidate, 'WORK_CANCELLED', { runId, kind: r.kind });
  const back = Object.entries(r.inputs).map(([id, q]) => `${formatQty(ctx.content, id, q)} ${ctx.content.items[id].label.toLowerCase()}`);
  return { kind: 'WORK_CANCELLED', message: `${label} cancelled.${back.length ? ` Returned: ${back.join(', ')}.` : ''}`, changes: { returned: r.inputs } };
}

// ---------------------------------------------------------------- machine work (I-13 admission)

const machineFail = (state, reason) => ({ ok: false, state, reason });

/**
 * Whether one more batch of `processId` could start at this bank now, judged against the
 * current state — which already holds every batch admitted earlier in the same transaction, so
 * two batches never share a claim or the same reserved space. Power is judged by Power's own
 * query on a hypothetical state that already contains the candidate run (no second allocator).
 * Pure. Returns {ok, state, reason, preview?:{kind, inputs, outputs, claim, duration, powerRate}}
 * where `state` is the S-42 operating state that blocks admission.
 */
export function preflightMachine(state, ctx, { bankId, processId }) {
  const { content, geography } = ctx;
  const bank = state.equipment?.banks?.[bankId];
  const model = content.equipment[bank?.model];
  const proc = model?.processes?.[processId];
  if (!bank || !proc) return machineFail('IDLE', 'That process is not available on this machine.');
  if (!bank.enabled) return machineFail('DISABLED', 'The machine is disabled.');
  if (!isOperational(bank)) return machineFail('OFFLINE', 'The machine is not operational.');
  if (runsAtBank(state, bankId).length >= bank.quantity) return machineFail('RUNNING', 'Every unit is busy.');
  if (!conditionHolds(state, geography, content, proc.unlock, 'unlock')) return machineFail('IDLE', 'You do not yet understand this process.');
  const hostId = bank.hostId;
  let inputs = {}, outputs = {}, claim = null;
  if (proc.kind === 'extract') {
    const site = authoredSite(state, content, hostId);
    const dep = site?.deposits?.[proc.deposit];
    if (!dep || dep.placeKey !== bank.placeId) return machineFail('STARVED', 'There is no deposit for it to work here.');
    const nodeId = `${state.entities[hostId].authoredId}.${proc.deposit}`;
    const available = claimable(state, nodeId);
    if (!(available > 0)) return machineFail('STARVED', `The ${dep.label ?? 'deposit'} is depleted.`);
    const qty = Math.min(proc.amount, available);
    outputs = { [proc.deposit]: qty };
    claim = { nodeId, qty };
  } else {
    for (const [itemId, qty] of Object.entries(proc.inputs)) {
      if (heldQty(state, hostId, itemId) < qty) return machineFail('STARVED', `Needs ${formatQty(content, itemId, qty)} ${content.items[itemId].label.toLowerCase()}.`);
    }
    inputs = { ...proc.inputs };
    outputs = { ...proc.outputs };
  }
  const delta = Object.fromEntries(Object.entries(inputs).map(([id, q]) => [id, -q]));
  if (admissionReason(state, content, hostId, delta, volumeOfItems(content, outputs))) return machineFail('IDLE', 'Hold full: no space for the output.');
  const preview = { kind: proc.kind, inputs, outputs, claim, duration: proc.duration, powerRate: proc.powerRate };
  // Power: Power's own query, with the candidate run joined at the end of run order.
  const candidateId = `run.${state.meta.nextId}`;
  const hypothetical = { ...state, work: { runs: { ...state.work.runs, [candidateId]: machineRun(state, bank, bankId, processId, null, null, preview) } } };
  const seat = powerStatus(hypothetical, geography, content, hostId)?.runs.find(r => r.runId === candidateId);
  if (seat?.blocker === 'OFFLINE') return machineFail('OFFLINE', 'No power for the machine\'s standby load.');
  if (seat && !(seat.speed > 0)) return machineFail('POWER LIMITED', 'Not enough power to run a batch.');
  return { ok: true, state: 'RUNNING', reason: '', preview };
}

function machineRun(state, bank, bankId, processId, orderId, issuedBy, p) {
  const now = state.meta.simulationTime;
  return {
    kind: p.kind, origin: 'machine', actorId: null, issuedBy, hostId: bank.hostId, placeId: bank.placeId, bankId, processId, orderId,
    startedAt: now, duration: p.duration, remaining: p.duration, anchorAt: now, speed: 1, powerRate: p.powerRate,
    inputs: p.inputs, outputs: p.outputs, claim: p.claim
  };
}

/**
 * Admit one machine batch (the I-13 entry point; called by the facility settlement only).
 * Withdraws its inputs and records its claim and reserved output. Returns the run id.
 */
export function admitMachineRun(candidate, ctx, { bankId, processId, orderId, issuedBy }) {
  const p = preflightMachine(candidate, ctx, { bankId, processId });
  check(p.ok, `machine batch cannot be admitted: ${p.reason}`);
  const bank = candidate.equipment.banks[bankId];
  const runId = allocateId(candidate, 'run');
  withdraw(candidate, bank.hostId, p.preview.inputs);
  candidate.work.runs[runId] = machineRun(candidate, bank, bankId, processId, orderId, issuedBy, p.preview);
  append(candidate, 'MACHINE_RUN_STARTED', { runId, bankId, processId });
  return runId;
}

/** Detach an order's in-flight batches (the order was stopped or replaced): they finish normally. */
export function detachRuns(candidate, orderId) {
  for (const r of Object.values(candidate.work.runs)) if (r.orderId === orderId) r.orderId = null;
}

/**
 * Whether the character may abort the batches at a machine: presence in its room (S-37) and
 * facility access; `reviewed` must be exactly the batches running now (I-10: a confirmation is
 * bound to what was reviewed). Pure.
 */
export function abortPreflight(state, ctx, { bankId, reviewed }) {
  const { content } = ctx;
  const bank = state.equipment?.banks?.[bankId];
  if (!bank || bank.hostId !== state.actor.hostId) return fail('request', 'There is no such machine here.');
  const denied = permissionReason(state, ctx.actorId, bank.hostId, 'useFacilities');
  if (denied) return fail('access', denied);
  if (bank.placeId !== state.actor.placeId) return fail('access', `You need to be in the ${placeLabel(state, content, bank.hostId, bank.placeId)} to control that.`);
  const current = runsAtBank(state, bankId).map(([id]) => id);
  if (!current.length) return fail('request', 'There are no batches to abort.');
  if (!Array.isArray(reviewed) || reviewed.length !== current.length || [...reviewed].sort().join() !== [...current].sort().join()) {
    return fail('request', 'The batches changed since you reviewed them. Review the loss again.');
  }
  const lost = {};
  for (const [, r] of runsAtBank(state, bankId)) for (const [id, q] of Object.entries(r.inputs)) lost[id] = (lost[id] ?? 0) + q;
  return { ok: true, preview: { runIds: current, lostInputs: lost } };
}

/**
 * Abort the reviewed batches (S-14, working phase): committed inputs are lost, extraction claims
 * are released, nothing is delivered. Returns the aborted runs' order ids for Orders.
 */
export function abortMachineRuns(candidate, ctx, { bankId, reviewed }) {
  const p = abortPreflight(candidate, ctx, { bankId, reviewed });
  if (!p.ok) throw new CommandError(p.reason, p.category);
  const aborted = [];
  for (const runId of p.preview.runIds) {
    const r = candidate.work.runs[runId];
    delete candidate.work.runs[runId];
    append(candidate, 'MACHINE_RUN_ABORTED', { runId, bankId, lostInputs: { ...r.inputs } });
    aborted.push({ runId, orderId: r.orderId });
  }
  const lost = Object.entries(p.preview.lostInputs).map(([id, q]) => `${formatQty(ctx.content, id, q)} ${ctx.content.items[id].label.toLowerCase()}`);
  const label = bankLabel(ctx.content, candidate.equipment.banks[bankId]);
  return { kind: 'MACHINE_RUN_ABORTED', message: `Aborted ${aborted.length} batch${aborted.length > 1 ? 'es' : ''} on the ${label.toLowerCase()}.${lost.length ? ` Lost: ${lost.join(', ')}.` : ''}`, changes: { aborted } };
}

// ---------------------------------------------------------------- integrator

/** Integrator: complete every run that ends at or before now, in run order. Returns [{runId, run}]. */
export function completeDueRuns(candidate) {
  const now = candidate.meta.simulationTime;
  const done = [];
  for (const runId of runOrder(candidate.work.runs)) {
    const r = candidate.work.runs[runId];
    if (!(endsAt(r) <= now)) continue;
    delete candidate.work.runs[runId];
    if (r.claim) depleteNode(candidate, r.claim.nodeId, r.claim.qty);
    if (Object.keys(r.outputs).length) deliver(candidate, r.hostId, r.outputs);
    append(candidate, 'WORK_COMPLETED', { runId, kind: r.kind });
    done.push({ runId, run: r });
  }
  return done;
}

/** Set each run's speed from domain/power's allocation, re-anchoring runs whose speed changed. */
export function applyAllocation(candidate, speeds) {
  const now = candidate.meta.simulationTime;
  for (const [runId, r] of Object.entries(candidate.work.runs)) {
    const s = speeds[runId];
    check(isFiniteNum(s) && s >= 0 && s <= 1, `allocation for ${runId} invalid`);
    if (s === r.speed) continue;
    r.remaining = remainingAt(r, now);
    check(r.remaining > 0, `run ${runId} re-anchored with no work left`);
    r.anchorAt = now;
    r.speed = s;
  }
}

export function initializeWork(candidate) {
  check(!has(candidate, 'work'), 'work already exists');
  candidate.work = { runs: {} };
  requireSlice(candidate, 'work');
}

// ---------------------------------------------------------------- validation

const RUN_KEYS = 'actorId,anchorAt,bankId,claim,duration,hostId,inputs,issuedBy,kind,orderId,origin,outputs,placeId,powerRate,processId,remaining,speed,startedAt';
const itemMap = (content, m) => isObj(m) && Object.entries(m).every(([id, q]) => has(content.items, id) && Number.isSafeInteger(q) && q > 0);

export function validateWork(state, geography, content) {
  const w = state.work;
  check(isObj(w) && Object.keys(w).join() === 'runs' && isObj(w.runs), 'work must be exactly {runs}');
  const now = state.meta.simulationTime;
  const actors = new Set(), claims = {}, perBank = {};
  for (const [runId, r] of Object.entries(w.runs)) {
    check(isSafeId(runId) && /\.\d+$/.test(runId) && isObj(r) && Object.keys(r).sort().join() === RUN_KEYS, `run ${runId} fields invalid`);
    const host = siteOf(state, geography, r.hostId);
    check(host && has(host.places, r.placeId), `run ${runId} place does not resolve`);
    if (r.origin === 'manual') {
      check(MANUAL_KINDS.includes(r.kind) && r.bankId === null && r.orderId === null && r.powerRate === 0 && r.issuedBy === r.actorId, `run ${runId} manual kind/fields invalid`);
      check(state.entities[r.actorId]?.kind === 'principal' && !actors.has(r.actorId), `run ${runId} actor invalid or already working`);
      actors.add(r.actorId);
      if (r.kind === 'collect') check(r.claim !== null && r.processId === null, `run ${runId} collection must claim a deposit`);
      else check(has(content.recipes, r.processId) && craftKind(content, content.recipes[r.processId]) === r.kind, `run ${runId} recipe invalid`);
    } else {
      check(r.origin === 'machine' && MACHINE_KINDS.includes(r.kind) && r.actorId === null, `run ${runId} machine kind/origin invalid`);
      check(state.entities[r.issuedBy]?.kind === 'principal', `run ${runId} issuer invalid`);
      const b = state.equipment.banks[r.bankId];
      const proc = content.equipment[b?.model]?.processes?.[r.processId];
      check(b && proc && proc.kind === r.kind && b.hostId === r.hostId && b.placeId === r.placeId, `run ${runId} machine or process does not resolve`);
      check(r.duration === proc.duration && r.powerRate === proc.powerRate, `run ${runId} does not match its process`);
      check(r.kind === 'extract' ? r.claim !== null : r.claim === null, `run ${runId} claim does not match its kind`);
      perBank[r.bankId] = (perBank[r.bankId] ?? 0) + 1;
      check(perBank[r.bankId] <= b.quantity, `bank ${r.bankId} has more batches than units`);
      check(r.orderId === null || (isSafeId(r.orderId) && state.orders?.orders?.[r.orderId]?.bankId === r.bankId && state.orders.orders[r.orderId].processId === r.processId), `run ${runId} order reference invalid`);
    }
    check(isFiniteNum(r.startedAt) && isFiniteNum(r.anchorAt) && r.startedAt <= r.anchorAt && r.anchorAt <= now, `run ${runId} times invalid`);
    check(isFiniteNum(r.duration) && r.duration > 0, `run ${runId} duration must be positive`);
    check(isFiniteNum(r.remaining) && r.remaining > 0 && r.remaining <= r.duration + 1e-9, `run ${runId} remaining must be 0..duration`);
    check(isFiniteNum(r.speed) && r.speed >= 0 && r.speed <= 1, `run ${runId} speed must be 0..1`);
    check(isFiniteNum(r.powerRate) && r.powerRate >= 0, `run ${runId} powerRate invalid`);
    check(endsAt(r) > now, `run ${runId} should already have completed`);
    check(itemMap(content, r.inputs) && itemMap(content, r.outputs), `run ${runId} items invalid`);
    if (r.claim !== null) {
      check(isObj(r.claim) && Object.keys(r.claim).sort().join() === 'nodeId,qty' && Number.isSafeInteger(r.claim.qty) && r.claim.qty > 0, `run ${runId} claim invalid`);
      check(has(state.deposits.remaining, r.claim.nodeId), `run ${runId} claims unknown deposit ${r.claim.nodeId}`);
      claims[r.claim.nodeId] = (claims[r.claim.nodeId] ?? 0) + r.claim.qty;
    }
  }
  for (const [nodeId, q] of Object.entries(claims)) check(q <= state.deposits.remaining[nodeId], `deposit ${nodeId} is over-claimed`);
}
