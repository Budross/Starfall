// Vessels (rev 3 §F; Stage 3 plan §1–§2). Sole writer of the `vessels` slice.
//
//   vessels{id: {status:'transit'|'holding'|'docked', drive?{energy},
//                holding: holdPos, nearHostId|null, dockFailure?{reason, at}
//                docked:  hostId, berthId, approachPos
//                transit: journey{from, to:{pos, hostId|null}, departAt, arriveAt, dockOnArrival, cost}}}
//
// Journey, docking and character movement are separate operations: nothing here ever
// writes `actor` (V-05). Propulsion is a content-defined capability per vessel; the one
// kind implemented now is an energy-only drive. Positions are derived, never stored per tick.
import { check, isObj, isSafeId, isVec3, isFiniteNum, has, dist, CommandError } from '../core/shape.js';
import { createEntity } from './entities.js';
import { append } from '../rules/ledger.js';
import { permissionReason } from '../rules/authority.js';
import { siteOf, vesselPositionAt } from './world.js';

const EPS_DISTANCE = 1e-9;
const STATUS = Object.freeze(['transit', 'holding', 'docked']);

/** Content definition of a vessel entity, or null. */
export function vesselDef(state, content, id) {
  const key = state.entities[id]?.authoredId;
  return key ? content.world.vessels?.[key] ?? null : null;
}

const needsDrive = propulsion => propulsion?.kind === 'energy-drive';

/**
 * Propulsion contract for one leg, independent of any vessel record (also used by content
 * validation). Returns {ok, reason?, duration, cost}.
 */
export function propulsionQuote(propulsion, distance) {
  switch (propulsion?.kind) {
    case 'energy-drive': {
      const { speed, energyPerWu } = propulsion;
      if (!(isFiniteNum(speed) && speed > 0 && isFiniteNum(energyPerWu) && energyPerWu >= 0)) return { ok: false, reason: 'No operational propulsion.' };
      return { ok: true, duration: distance / speed, cost: { energy: distance * energyPerWu } };
    }
    default:
      return { ok: false, reason: 'No operational propulsion.' };
  }
}

/** The holding point off a host: the host position plus the stand-off, back toward `from`. */
export function approachPoint(hostPos, from, standoff) {
  const d = { x: from.x - hostPos.x, y: from.y - hostPos.y, z: from.z - hostPos.z };
  const n = Math.hypot(d.x, d.y, d.z);
  if (!(n > 0) || !(standoff > 0)) return { ...hostPos };
  const s = Math.min(standoff, n);
  return { x: hostPos.x + d.x / n * s, y: hostPos.y + d.y / n * s, z: hostPos.z + d.z / n * s };
}

function canPay(v, propulsion, cost) {
  if (propulsion.kind === 'energy-drive') return v.drive.energy >= cost.energy;
  return false;
}
function pay(v, propulsion, cost) {
  if (propulsion.kind === 'energy-drive') v.drive.energy -= cost.energy;
}

/**
 * The one journey quote (V-09), shared by preview, execution and preflight. Pure.
 * Returns {ok, reason?, distance, duration, cost, approachPos}.
 */
export function quote(state, geography, content, vesselId, targetHostId) {
  const v = state.vessels?.[vesselId], def = vesselDef(state, content, vesselId);
  if (!v || !def) return { ok: false, reason: 'Unknown vessel.' };
  const host = siteOf(state, geography, targetHostId);
  if (!host) return { ok: false, reason: 'That destination is not a station.' };
  if (state.entities[targetHostId]?.lifecycle !== 'active') return { ok: false, reason: 'That station is not operational.' };
  const from = vesselPositionAt(state, geography, v, state.meta.simulationTime);
  const approachPos = approachPoint(host.position, from, def.approachStandoff);
  const distance = dist(from, approachPos);
  if (!(distance > EPS_DISTANCE)) return { ok: false, reason: 'The vessel is already there.', distance, approachPos };
  const leg = propulsionQuote(def.propulsion, distance);
  if (!leg.ok) return { ok: false, reason: leg.reason, distance, approachPos };
  const base = { distance, duration: leg.duration, cost: leg.cost, approachPos };
  if (!canPay(v, def.propulsion, leg.cost)) return { ok: false, reason: 'Not enough drive energy for this journey.', ...base };
  return { ok: true, ...base };
}

function vesselOrThrow(candidate, vesselId) {
  const v = candidate.vessels?.[vesselId];
  if (!v) throw new CommandError('Unknown vessel.', 'request');
  if (candidate.entities[vesselId]?.lifecycle !== 'active') throw new CommandError('The vessel is not operational.', 'access');
  return v;
}

/** Depart toward a host's approach point. Paid upfront from the shared quote; no refund ever. */
export function depart(candidate, ctx, { vesselId, targetHostId, dockOnArrival = false }) {
  const v = vesselOrThrow(candidate, vesselId);
  if (v.status === 'docked') throw new CommandError('The vessel is docked. Undock it first.', 'state');
  if (v.status === 'transit') throw new CommandError('The vessel is already under way.', 'state');
  const q = quote(candidate, ctx.geography, ctx.content, vesselId, targetHostId);
  if (!q.ok) throw new CommandError(q.reason, 'resource');
  const def = vesselDef(candidate, ctx.content, vesselId);
  const now = candidate.meta.simulationTime;
  const from = { ...v.holdPos };
  pay(v, def.propulsion, q.cost);
  delete v.holdPos; delete v.nearHostId; delete v.dockFailure;
  v.status = 'transit';
  v.journey = { from, to: { pos: q.approachPos, hostId: targetHostId }, departAt: now, arriveAt: now + q.duration, dockOnArrival: dockOnArrival === true, cost: q.cost };
  append(candidate, 'SHIP_DEPARTED', { vesselId, toHostId: targetHostId, arriveAt: v.journey.arriveAt });
  return { kind: 'SHIP_DEPARTED', message: `Departed. Arrival in ${Math.ceil(q.duration)} s.`, changes: { vessels: [vesselId] } };
}

/** Cancel a journey: hold at the derived position at this instant. No refund (V-03). */
export function cancel(candidate, ctx, { vesselId }) {
  const v = vesselOrThrow(candidate, vesselId);
  if (v.status !== 'transit') throw new CommandError('The vessel has no journey to cancel.', 'state');
  const pos = vesselPositionAt(candidate, ctx.geography, v, candidate.meta.simulationTime);
  delete v.journey;
  Object.assign(v, { status: 'holding', holdPos: pos, nearHostId: null });
  append(candidate, 'JOURNEY_CANCELLED', { vesselId });
  return { kind: 'JOURNEY_CANCELLED', message: 'Journey cancelled. The vessel is holding position.', changes: { vessels: [vesselId] } };
}

/** Why a holding vessel cannot dock at its near host right now, or ''. */
function dockBlocker(candidate, geography, vesselId, v) {
  if (v.status !== 'holding' || !v.nearHostId) return 'The vessel is not holding at a station.';
  const ent = candidate.entities[vesselId];
  const principal = ent.controller ?? ent.owner;
  if (!principal) return 'No one controls the vessel.';
  const denied = permissionReason(candidate, principal, v.nearHostId, 'dock');
  if (denied) return denied;
  if (!freeBerth(candidate, geography, v.nearHostId)) return 'No free berth.';
  return '';
}

function freeBerth(state, geography, hostId) {
  const taken = new Set(Object.values(state.vessels).filter(o => o.status === 'docked' && o.hostId === hostId).map(o => o.berthId));
  return siteOf(state, geography, hostId).berths.find(b => !taken.has(b)) ?? null;
}

function doDock(candidate, geography, vesselId, v) {
  const berthId = freeBerth(candidate, geography, v.nearHostId);
  const hostId = v.nearHostId, approachPos = v.holdPos;
  delete v.holdPos; delete v.nearHostId; delete v.dockFailure;
  Object.assign(v, { status: 'docked', hostId, berthId, approachPos });
  append(candidate, 'SHIP_DOCKED', { vesselId, hostId, berthId });
  return { hostId, berthId };
}

/** Player command: dock a holding vessel at its near host. A blocked request commits nothing. */
export function dock(candidate, ctx, { vesselId }) {
  const v = vesselOrThrow(candidate, vesselId);
  const blocker = dockBlocker(candidate, ctx.geography, vesselId, v);
  if (blocker) throw new CommandError(blocker, 'access');
  doDock(candidate, ctx.geography, vesselId, v);
  return { kind: 'SHIP_DOCKED', message: 'Docked.', changes: { vessels: [vesselId] } };
}

/** Undock: hold at the approach point the vessel docked from. */
export function undock(candidate, ctx, { vesselId }) {
  const v = vesselOrThrow(candidate, vesselId);
  if (v.status !== 'docked') throw new CommandError('The vessel is not docked.', 'state');
  const { hostId, berthId, approachPos } = v;
  delete v.hostId; delete v.berthId; delete v.approachPos;
  Object.assign(v, { status: 'holding', holdPos: approachPos, nearHostId: hostId });
  append(candidate, 'SHIP_UNDOCKED', { vesselId, hostId, berthId });
  return { kind: 'SHIP_UNDOCKED', message: 'Undocked. The vessel is holding off the station.', changes: { vessels: [vesselId] } };
}

/** Earliest pending arrival time, or Infinity. */
export function nextArrival(state) {
  let t = Infinity;
  for (const v of Object.values(state.vessels)) if (v.status === 'transit' && v.journey.arriveAt < t) t = v.journey.arriveAt;
  return t;
}

/**
 * Integrator boundary settlement (fixed order, rev 3 §I): every arrival due at the current
 * time (vessel id order), then dockOnArrival for those vessels. Arrival never docks by
 * itself; a failed docking leaves the vessel holding with a recorded reason (V-04).
 */
export function settleArrivals(candidate, ctx) {
  const now = candidate.meta.simulationTime;
  const due = Object.keys(candidate.vessels).sort().filter(id => {
    const v = candidate.vessels[id];
    return v.status === 'transit' && v.journey.arriveAt <= now;
  });
  const dockNext = [];
  for (const id of due) {
    const v = candidate.vessels[id], j = v.journey;
    delete v.journey;
    Object.assign(v, { status: 'holding', holdPos: { ...j.to.pos }, nearHostId: j.to.hostId });
    append(candidate, 'SHIP_ARRIVED', { vesselId: id, hostId: j.to.hostId });
    if (j.dockOnArrival && j.to.hostId) dockNext.push(id);
  }
  for (const id of dockNext) {
    const v = candidate.vessels[id];
    const blocker = candidate.entities[id]?.lifecycle === 'active' ? dockBlocker(candidate, ctx.geography, id, v) : 'The vessel is not operational.';
    if (blocker) {
      v.dockFailure = { reason: blocker, at: now };
      append(candidate, 'SHIP_DOCK_FAILED', { vesselId: id, hostId: v.nearHostId, reason: blocker });
    } else {
      doDock(candidate, ctx.geography, id, v);
    }
  }
  return due;
}

/**
 * Create every authored vessel: entity, a valid holding record at its authored start, then
 * its authored journey through the real depart() at the current simulation time. Called by
 * world creation only.
 */
export function initializeVessels(candidate, ctx) {
  check(!has(candidate, 'vessels'), 'vessels are already initialized');
  candidate.vessels = {};
  const defs = ctx.content.world.vessels ?? {};
  for (const key of Object.keys(defs).sort()) {
    const def = defs[key];
    const owner = def.owner ?? null, controller = def.controller ?? owner;
    createEntity(candidate, key, { kind: 'vessel', owner, controller, authoredId: key });
    candidate.vessels[key] = {
      status: 'holding', holdPos: { ...def.start }, nearHostId: null,
      ...(needsDrive(def.propulsion) ? { drive: { energy: def.initialEnergy } } : {})
    };
    append(candidate, 'VESSEL_CREATED', { vesselId: key });
    if (def.initialJourney) {
      const target = ctx.geography.anchors[def.initialJourney.to];
      check(target, `vessel ${key} initial journey target does not resolve`);
      try { depart(candidate, ctx, { vesselId: key, targetHostId: target, dockOnArrival: def.initialJourney.dockOnArrival === true }); }
      catch (e) { throw new Error(`vessel ${key} cannot start its authored journey: ${e.message}`); }
    }
  }
}

// ---------------------------------------------------------------- validation

const exactKeys = (o, keys) => isObj(o) && Object.keys(o).sort().join() === [...keys].sort().join();

export function validateVessels(state, geography, content) {
  check(isObj(state.vessels), 'vessels must be an object');
  const now = state.meta.simulationTime;
  const berths = new Set();
  for (const [id, v] of Object.entries(state.vessels)) {
    const ent = state.entities[id];
    check(isSafeId(id) && ent?.kind === 'vessel', `vessel ${id} has no vessel entity`);
    const def = vesselDef(state, content, id);
    check(def, `vessel ${id} has no content definition`);
    check(isObj(v) && STATUS.includes(v.status), `vessel ${id} status invalid`);
    const drive = needsDrive(def.propulsion);
    const base = drive ? ['status', 'drive'] : ['status'];
    if (drive) {
      check(exactKeys(v.drive, ['energy']) && isFiniteNum(v.drive.energy) && v.drive.energy >= 0 && v.drive.energy <= def.propulsion.capacity + 1e-9, `vessel ${id} drive energy must be 0..${def.propulsion.capacity}`);
    }
    if (v.status === 'transit') {
      check(exactKeys(v, [...base, 'journey']), `vessel ${id} transit fields invalid`);
      const j = v.journey;
      check(exactKeys(j, ['from', 'to', 'departAt', 'arriveAt', 'dockOnArrival', 'cost']), `vessel ${id} journey fields invalid`);
      check(isVec3(j.from) && exactKeys(j.to, ['pos', 'hostId']) && isVec3(j.to.pos), `vessel ${id} journey endpoints invalid`);
      check(j.to.hostId === null || siteOf(state, geography, j.to.hostId), `vessel ${id} journey host does not resolve`);
      check(isFiniteNum(j.departAt) && isFiniteNum(j.arriveAt) && j.departAt <= now && now < j.arriveAt, `vessel ${id} journey times invalid`);
      check(typeof j.dockOnArrival === 'boolean', `vessel ${id} dockOnArrival must be boolean`);
      check(isObj(j.cost) && Object.values(j.cost).every(x => isFiniteNum(x) && x >= 0), `vessel ${id} journey cost invalid`);
    } else if (v.status === 'holding') {
      const keys = [...base, 'holdPos', 'nearHostId', ...(has(v, 'dockFailure') ? ['dockFailure'] : [])];
      check(exactKeys(v, keys), `vessel ${id} holding fields invalid`);
      check(isVec3(v.holdPos), `vessel ${id} holdPos invalid`);
      check(v.nearHostId === null || siteOf(state, geography, v.nearHostId), `vessel ${id} nearHostId does not resolve`);
      if (v.dockFailure) check(exactKeys(v.dockFailure, ['reason', 'at']) && typeof v.dockFailure.reason === 'string' && isFiniteNum(v.dockFailure.at) && v.dockFailure.at <= now, `vessel ${id} dockFailure invalid`);
    } else {
      check(exactKeys(v, [...base, 'hostId', 'berthId', 'approachPos']), `vessel ${id} docked fields invalid`);
      const host = siteOf(state, geography, v.hostId);
      check(host && host.berths.includes(v.berthId), `vessel ${id} berth does not resolve`);
      check(state.entities[v.hostId]?.lifecycle === 'active', `vessel ${id} is docked at an inactive host`);
      check(isVec3(v.approachPos), `vessel ${id} approachPos invalid`);
      const key = `${v.hostId}/${v.berthId}`;
      check(!berths.has(key), `berth ${key} has more than one vessel`);
      berths.add(key);
    }
  }
  for (const [id, e] of Object.entries(state.entities)) if (e.kind === 'vessel') check(has(state.vessels, id), `vessel entity ${id} has no vessel record`);
}
