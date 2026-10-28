// Machine orders (I-17 subset). Sole writer of the `orders` slice.
//
//   orders{orders{orderId:{bankId, processId, mode:'repeat'|'count', requested, completed, aborted, issuedBy}}}
//
// An order is persistent manufacturing intent for one machine (at most one per bank): Make N
// (`count`, requested = N) or Repeat until stopped (`repeat`, requested = null). Each admitted
// batch is an ordinary accepted run owned by Work (I-13) carrying the order's id; batches in
// flight are derived from Work and never stored here.
//
// Accounting (S-45, decided 2026-10-26): a count order admits at most N batches in total. A
// completed batch increments `completed`; an aborted batch increments `aborted` and still
// counts against the order, so it is not replaced. The order is complete — removed, with
// ORDER_COMPLETED — in the transaction where completed + aborted reaches N with nothing in
// flight. Stopping or replacing an order detaches its in-flight batches: they finish and
// deliver normally, counting toward nothing. A repeat order keeps admitting until stopped.
import { check, isObj, isSafeId, has, CommandError } from '../core/shape.js';
import { allocateId, requireSlice } from '../core/state.js';
import { authoredSite, conditionHolds } from './world.js';
import { bankLabel } from './equipment.js';
import { preflightMachine, runsAtBank, detachRuns, endsAt, remainingAt } from './work.js';
import { powerStatus } from './power.js';
import { append } from '../rules/ledger.js';
import { permissionReason } from '../rules/authority.js';

export const MAX_ORDER_COUNT = 999;
export const ORDER_MODES = Object.freeze(['repeat', 'count']);

/** The order on a bank, as [orderId, order], or null. */
export function orderOf(state, bankId) {
  for (const [id, o] of Object.entries(state.orders?.orders ?? {})) if (o.bankId === bankId) return [id, o];
  return null;
}

/** Batches in flight for an order (derived from Work). */
export const inFlight = (state, orderId) => Object.values(state.work?.runs ?? {}).filter(r => r.orderId === orderId).length;

/** Whether a count order has admitted everything it asked for. A repeat order never is. */
export const satisfied = (state, orderId, o) => o.mode === 'count' && o.completed + o.aborted + inFlight(state, orderId) >= o.requested;

const fail = (category, reason) => ({ ok: false, category, reason });
const placeLabel = (state, content, hostId, placeId) => (authoredSite(state, content, hostId)?.places?.[placeId]?.label ?? 'compartment').toLowerCase();

/** Presence in the machine's room and facility access (S-37). */
function controlReason(state, ctx, bank) {
  if (!bank || bank.hostId !== state.actor.hostId) return fail('request', 'There is no such machine here.');
  const denied = permissionReason(state, ctx.actorId, bank.hostId, 'useFacilities');
  if (denied) return fail('access', denied);
  if (bank.placeId !== state.actor.placeId) return fail('access', `You need to be in the ${placeLabel(state, ctx.content, bank.hostId, bank.placeId)} to control that.`);
  return null;
}

/** Whether the character can give this machine an order now. Pure; shared by the observer and the command. */
export function orderPreflight(state, ctx, { bankId, processId, mode, count }) {
  const { content } = ctx;
  const bank = state.equipment?.banks?.[bankId];
  const blocked = controlReason(state, ctx, bank);
  if (blocked) return blocked;
  const proc = content.equipment[bank.model].processes?.[processId];
  if (!proc) return fail('request', 'That process is not available on this machine.');
  if (!conditionHolds(state, ctx.geography, content, proc.unlock, 'unlock')) return fail('research', 'You do not yet understand this process.');
  if (!ORDER_MODES.includes(mode)) return fail('request', 'Choose Make a number of batches, or Repeat until stopped.');
  if (mode === 'count' && !(Number.isSafeInteger(count) && count >= 1 && count <= MAX_ORDER_COUNT)) return fail('request', `Choose between 1 and ${MAX_ORDER_COUNT} batches.`);
  return { ok: true };
}

function endOrder(candidate, orderId, type) {
  const o = candidate.orders.orders[orderId];
  delete candidate.orders.orders[orderId];
  append(candidate, type, { orderId, bankId: o.bankId, completed: o.completed, aborted: o.aborted });
}

/** Give a machine an order, replacing any existing one (whose batches are detached and finish). */
export function setOrder(candidate, ctx, { bankId, processId, mode, count }) {
  const p = orderPreflight(candidate, ctx, { bankId, processId, mode, count });
  if (!p.ok) throw new CommandError(p.reason, p.category);
  const existing = orderOf(candidate, bankId);
  if (existing) { detachRuns(candidate, existing[0]); endOrder(candidate, existing[0], 'ORDER_STOPPED'); }
  const orderId = allocateId(candidate, 'order');
  candidate.orders.orders[orderId] = { bankId, processId, mode, requested: mode === 'count' ? count : null, completed: 0, aborted: 0, issuedBy: ctx.actorId };
  append(candidate, 'ORDER_SET', { orderId, bankId, processId, mode, requested: mode === 'count' ? count : null });
  const bank = candidate.equipment.banks[bankId];
  const proc = ctx.content.equipment[bank.model].processes[processId];
  const what = mode === 'count' ? `${count} batch${count > 1 ? 'es' : ''}` : 'until stopped';
  return { kind: 'ORDER_SET', message: `${bankLabel(ctx.content, bank)}: ${proc.label.toLowerCase()}, ${what}.`, changes: { orders: [orderId] } };
}

/** Whether the character can stop this machine's order now. */
export function stopPreflight(state, ctx, { bankId }) {
  const blocked = controlReason(state, ctx, state.equipment?.banks?.[bankId]);
  if (blocked) return blocked;
  if (!orderOf(state, bankId)) return fail('request', 'The machine has no order.');
  return { ok: true };
}

/** Stop admitting new batches. Batches already running finish and deliver, counting toward nothing. */
export function stopOrder(candidate, ctx, { bankId }) {
  const p = stopPreflight(candidate, ctx, { bankId });
  if (!p.ok) throw new CommandError(p.reason, p.category);
  const [orderId] = orderOf(candidate, bankId);
  detachRuns(candidate, orderId);
  endOrder(candidate, orderId, 'ORDER_STOPPED');
  const bank = candidate.equipment.banks[bankId];
  return { kind: 'ORDER_STOPPED', message: `${bankLabel(ctx.content, bank)}: order stopped. Running batches will finish.`, changes: { orders: [orderId] } };
}

function finishIfDone(candidate, orderId) {
  const o = candidate.orders.orders[orderId];
  if (o && o.mode === 'count' && o.completed + o.aborted >= o.requested && inFlight(candidate, orderId) === 0) endOrder(candidate, orderId, 'ORDER_COMPLETED');
}

/** Count completed batches against their orders (same transaction as the completion). */
export function recordCompletions(candidate, done) {
  for (const { run } of done) {
    if (!run.orderId || !has(candidate.orders.orders, run.orderId)) continue;
    candidate.orders.orders[run.orderId].completed += 1;
    finishIfDone(candidate, run.orderId);
  }
}

/** Count aborted batches against their orders (S-45: they are not replaced). */
export function recordAborts(candidate, aborted) {
  for (const { orderId } of aborted) {
    if (!orderId || !has(candidate.orders.orders, orderId)) continue;
    candidate.orders.orders[orderId].aborted += 1;
    finishIfDone(candidate, orderId);
  }
}

/**
 * The next batch to admit, judged against the current state: the first order in order-id
 * order that is not yet satisfied and whose machine can take a batch now. Pure; the
 * facility settlement admits it, reconciles power, then asks again.
 */
export function nextAdmission(state, ctx) {
  const ids = Object.keys(state.orders?.orders ?? {}).sort((a, b) => Number(a.slice(a.lastIndexOf('.') + 1)) - Number(b.slice(b.lastIndexOf('.') + 1)));
  for (const orderId of ids) {
    const o = state.orders.orders[orderId];
    if (satisfied(state, orderId, o)) continue;
    if (preflightMachine(state, ctx, { bankId: o.bankId, processId: o.processId }).ok) return { orderId, bankId: o.bankId, processId: o.processId, issuedBy: o.issuedBy };
  }
  return null;
}

/**
 * A machine's operating state (S-42) and what it is doing. Pure; the observer, Systems and the
 * scene all read it. States: RUNNING · POWER LIMITED · OFFLINE · DISABLED · STARVED · IDLE.
 */
export function machineStatus(state, geography, content, bankId) {
  const bank = state.equipment.banks[bankId];
  const ps = powerStatus(state, geography, content, bank.hostId);
  const seats = Object.fromEntries((ps?.runs ?? []).map(r => [r.runId, r]));
  const now = state.meta.simulationTime;
  const runs = runsAtBank(state, bankId).map(([runId, r]) => {
    const left = Math.max(0, remainingAt(r, now)), end = endsAt(r);
    return { runId, processId: r.processId, fraction: Math.min(1, Math.max(0, 1 - left / r.duration)), secondsLeft: Number.isFinite(end) ? Math.max(0, Math.ceil(end - now)) : null,
      speed: r.speed, blocker: seats[runId]?.blocker ?? null, inputs: { ...r.inputs }, outputs: { ...r.outputs }, ordered: r.orderId !== null };
  });
  const entry = orderOf(state, bankId);
  const order = entry ? { orderId: entry[0], processId: entry[1].processId, mode: entry[1].mode, requested: entry[1].requested,
    completed: entry[1].completed, aborted: entry[1].aborted, inFlight: inFlight(state, entry[0]) } : null;
  const unitsOnline = ps?.banks.find(b => b.bankId === bankId)?.online ?? bank.quantity;
  let status, reason;
  if (!bank.enabled) { status = 'DISABLED'; reason = 'Switched off. Batches are paused, not lost.'; }
  else if (runs.some(r => r.blocker === 'OFFLINE') || (!runs.length && unitsOnline < bank.quantity)) { status = 'OFFLINE'; reason = 'No power for the standby load.'; }
  else if (runs.some(r => r.speed < 1)) { status = 'POWER LIMITED'; reason = 'Not enough power to run at full rate.'; }
  else if (runs.length) { status = 'RUNNING'; reason = ''; }
  else if (!order) { status = 'IDLE'; reason = 'No order.'; }
  else {
    const p = preflightMachine(state, { content, geography, actorId: entry[1].issuedBy }, { bankId, processId: order.processId });
    status = p.ok ? 'IDLE' : (p.state === 'RUNNING' ? 'IDLE' : p.state);
    reason = p.ok ? 'Ready.' : p.reason;
  }
  return { bankId, status, reason, units: bank.quantity, unitsOnline, baseline: content.equipment[bank.model].baseline ?? 0, order, runs };
}

// ---------------------------------------------------------------- creation and validation

export function initializeOrders(candidate) {
  check(!has(candidate, 'orders'), 'orders already exist');
  candidate.orders = { orders: {} };
  requireSlice(candidate, 'orders');
}

const ORDER_KEYS = 'aborted,bankId,completed,issuedBy,mode,processId,requested';
const count = v => Number.isSafeInteger(v) && v >= 0;

export function validateOrders(state, geography, content) {
  const o = state.orders;
  check(isObj(o) && Object.keys(o).join() === 'orders' && isObj(o.orders), 'orders must be exactly {orders}');
  const banks = new Set();
  for (const [orderId, ord] of Object.entries(o.orders)) {
    check(isSafeId(orderId) && /\.\d+$/.test(orderId) && isObj(ord) && Object.keys(ord).sort().join() === ORDER_KEYS, `order ${orderId} fields invalid`);
    const bank = state.equipment.banks[ord.bankId];
    check(bank && content.equipment[bank.model].processes?.[ord.processId], `order ${orderId} machine or process does not resolve`);
    check(!banks.has(ord.bankId), `bank ${ord.bankId} has more than one order`);
    banks.add(ord.bankId);
    check(ORDER_MODES.includes(ord.mode) && count(ord.completed) && count(ord.aborted), `order ${orderId} mode or counts invalid`);
    check(state.entities[ord.issuedBy]?.kind === 'principal', `order ${orderId} issuer invalid`);
    if (ord.mode === 'repeat') check(ord.requested === null, `order ${orderId}: a repeat order has no requested count`);
    else {
      check(Number.isSafeInteger(ord.requested) && ord.requested >= 1 && ord.requested <= MAX_ORDER_COUNT, `order ${orderId} requested count invalid`);
      check(ord.completed + ord.aborted + inFlight(state, orderId) <= ord.requested, `order ${orderId} is over-admitted`);
      check(ord.completed + ord.aborted < ord.requested, `order ${orderId} is complete and should have been removed`);
    }
  }
}
