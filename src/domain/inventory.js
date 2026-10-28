// Inventory (Stage 4). Sole writer of the `inventory` and `deposits` slices.
//
//   inventory{holds{holderId:{itemId: qty}}}     — sparse; qty is an integer: cm³ for bulk
//                                                   Resources, a count for Components/Products
//   deposits{initializedAt, remaining{nodeId: cm³}} — dense over every geography node (S-26)
//
// One storage query answers every storage question (storageStatus, A-05). Admission checks
// the net exchange, so material freed by a change counts (I-01). An overloaded hold is valid
// but may only shrink (I-02). Committed run inputs and reserved run output are derived from
// `work`; they are never stored twice.
import { check, isObj, isSafeId, has, CommandError } from '../core/shape.js';
import { requireSlice } from '../core/state.js';
import { allDepositNodes } from '../core/validate.js';
import { authoredSite } from './world.js';
import { append } from '../rules/ledger.js';
import { permissionReason } from '../rules/authority.js';

// ---------------------------------------------------------------- quantities

export const quantityKind = (content, itemId) => content.items[itemId].category === 'resource' ? 'bulk' : 'count';

/** Volume in cm³ of `qty` units of an item. */
export function volumeOf(content, itemId, qty) {
  return quantityKind(content, itemId) === 'bulk' ? qty : qty * content.items[itemId].unitVolumeCm3;
}

export const volumeOfItems = (content, items) => Object.entries(items).reduce((v, [id, q]) => v + volumeOf(content, id, q), 0);

/** "0.05 m³" for bulk, "2" for counted items. */
export function formatQty(content, itemId, qty) {
  if (quantityKind(content, itemId) === 'count') return String(qty);
  const m3 = qty / 1_000_000;
  return `${Number(m3.toFixed(m3 < 0.1 ? 3 : 2))} m³`;
}

// ---------------------------------------------------------------- queries

export const holdOf = (state, holderId) => state.inventory?.holds?.[holderId] ?? {};
export const heldQty = (state, holderId, itemId) => holdOf(state, holderId)[itemId] ?? 0;

export function holdCapacity(state, content, holderId) {
  return authoredSite(state, content, holderId)?.hold?.capacityCm3 ?? 0;
}

/** Remaining amount of a deposit node, minus the claims of accepted runs. */
export function claimable(state, nodeId) {
  const remaining = state.deposits?.remaining?.[nodeId] ?? 0;
  let claimed = 0;
  for (const r of Object.values(state.work?.runs ?? {})) if (r.claim?.nodeId === nodeId) claimed += r.claim.qty;
  return remaining - claimed;
}

/**
 * The one storage query (A-05): ordinary cargo against capacity, plus what accepted work holds
 * outside the hold — committed inputs (never counted) and reserved output volume (counted, so
 * completion always fits).
 */
export function storageStatus(state, content, holderId) {
  const hold = holdOf(state, holderId);
  const byCategory = {};
  let used = 0;
  for (const [itemId, qty] of Object.entries(hold)) {
    const v = volumeOf(content, itemId, qty);
    used += v;
    const cat = content.items[itemId].category;
    byCategory[cat] = (byCategory[cat] ?? 0) + v;
  }
  let reservedForWork = 0;
  const committedInputs = [];
  for (const [runId, r] of Object.entries(state.work?.runs ?? {})) {
    if (r.hostId !== holderId) continue;
    reservedForWork += volumeOfItems(content, r.outputs);
    if (Object.keys(r.inputs).length) committedInputs.push({ runId, items: { ...r.inputs }, volume: volumeOfItems(content, r.inputs) });
  }
  const capacity = holdCapacity(state, content, holderId);
  return { used, capacity, reservedForWork, free: capacity - used - reservedForWork, overloaded: used + reservedForWork > capacity, byCategory, committedInputs };
}

/**
 * Whether a net change (itemId → signed qty) is admissible, with `extraReserve` cm³ of new
 * output reservation. A change that fits is admitted; an overloaded hold admits only changes
 * that do not increase its occupied volume. Returns '' or a storage reason.
 */
export function admissionReason(state, content, holderId, delta, extraReserve = 0) {
  const s = storageStatus(state, content, holderId);
  for (const [itemId, q] of Object.entries(delta)) {
    if (q < 0 && heldQty(state, holderId, itemId) < -q) return `Not enough ${content.items[itemId].label.toLowerCase()} here.`;
  }
  const change = volumeOfItems(content, delta) + extraReserve;
  const after = s.used + s.reservedForWork + change;
  if (after <= s.capacity || change <= 0) return '';
  const m3 = v => Number((v / 1_000_000).toFixed(3));
  return `Not enough hold space: this needs ${m3(change)} m³ and ${m3(Math.max(0, s.capacity - s.used - s.reservedForWork))} m³ is free.`;
}

// ---------------------------------------------------------------- writers

function addTo(candidate, holderId, itemId, qty) {
  check(Number.isSafeInteger(qty) && qty > 0, `quantity of ${itemId} must be a positive integer`);
  const hold = candidate.inventory.holds[holderId] ??= {};
  hold[itemId] = (hold[itemId] ?? 0) + qty;
}

function takeFrom(candidate, holderId, itemId, qty) {
  check(Number.isSafeInteger(qty) && qty > 0, `quantity of ${itemId} must be a positive integer`);
  const hold = candidate.inventory.holds[holderId];
  if (!hold || (hold[itemId] ?? 0) < qty) throw new CommandError(`Not enough ${itemId} here.`, 'materials');
  hold[itemId] -= qty;
  if (hold[itemId] === 0) delete hold[itemId];
  if (!Object.keys(hold).length) delete candidate.inventory.holds[holderId];
}

/** Remove items from a hold (run inputs, research samples). Throws if any is short. */
export function withdraw(candidate, holderId, items) {
  for (const [itemId, qty] of Object.entries(items)) takeFrom(candidate, holderId, itemId, qty);
}

/**
 * Put items into a hold without an admission check: run output whose volume was reserved at
 * start, or returned run inputs (which may overload the hold; overload is valid, I-02).
 */
export function deliver(candidate, holderId, items) {
  for (const [itemId, qty] of Object.entries(items)) addTo(candidate, holderId, itemId, qty);
}

/** Reduce a deposit node by a completed collection. Returns true when it reaches 0. */
export function depleteNode(candidate, nodeId, qty) {
  const r = candidate.deposits.remaining;
  check(has(r, nodeId) && Number.isSafeInteger(qty) && qty > 0 && r[nodeId] >= qty, `deposit ${nodeId} cannot yield ${qty}`);
  r[nodeId] -= qty;
  if (r[nodeId] === 0) { append(candidate, 'DEPOSIT_DEPLETED', { nodeId }); return true; }
  return false;
}

/** Explicit, confirmed discard from the occupied host's hold (I-03). */
export function discard(candidate, ctx, { itemId, qty, confirmed }) {
  const hostId = candidate.actor.hostId;
  if (confirmed !== true) throw new CommandError('Discarding needs explicit confirmation.', 'request');
  if (!has(ctx.content.items, itemId)) throw new CommandError('Unknown item.', 'request');
  if (!(Number.isSafeInteger(qty) && qty > 0)) throw new CommandError('Choose a positive amount to discard.', 'request');
  const denied = permissionReason(candidate, ctx.actorId, hostId, 'useFacilities');
  if (denied) throw new CommandError(denied, 'access');
  if (heldQty(candidate, hostId, itemId) < qty) throw new CommandError('You do not hold that much here.', 'materials');
  takeFrom(candidate, hostId, itemId, qty);
  append(candidate, 'CARGO_DISCARDED', { holderId: hostId, itemId, qty });
  return { kind: 'CARGO_DISCARDED', message: `Discarded ${formatQty(ctx.content, itemId, qty)} of ${ctx.content.items[itemId].label.toLowerCase()}.`, changes: { discarded: { [itemId]: qty } } };
}

// ---------------------------------------------------------------- creation (world creation only)

export function initializeInventory(candidate) {
  check(!has(candidate, 'inventory'), 'inventory already exists');
  candidate.inventory = { holds: {} };
  requireSlice(candidate, 'inventory');
}

/** Dense deposits over every geography node, at their initial amounts (S-26). Never refills. */
export function initializeDeposits(candidate, { geography }) {
  check(!has(candidate, 'deposits'), 'deposits already exist (they are never re-initialized)');
  const remaining = {};
  for (const n of allDepositNodes(geography)) remaining[n.nodeId] = n.initial;
  candidate.deposits = { initializedAt: candidate.meta.simulationTime, remaining };
  requireSlice(candidate, 'deposits');
  append(candidate, 'DEPOSITS_INITIALIZED', { nodes: Object.keys(remaining).length });
}

// ---------------------------------------------------------------- validation

export function validateInventory(state, geography, content) {
  const inv = state.inventory;
  check(isObj(inv) && Object.keys(inv).join() === 'holds' && isObj(inv.holds), 'inventory must be exactly {holds}');
  for (const [holderId, hold] of Object.entries(inv.holds)) {
    check(isSafeId(holderId) && holdCapacity(state, content, holderId) > 0, `hold ${holderId} is not a storage holder`);
    check(isObj(hold) && Object.keys(hold).length > 0, `hold ${holderId} must be a non-empty object`);
    for (const [itemId, qty] of Object.entries(hold)) {
      check(has(content.items, itemId), `hold ${holderId} contains unknown item ${itemId}`);
      check(Number.isSafeInteger(qty) && qty > 0, `hold ${holderId} quantity of ${itemId} must be a positive integer`);
    }
  }
}
