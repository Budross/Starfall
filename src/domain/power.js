// Facility power (S-12, S-44). Sole writer of the `power` slice.
//
//   power{hosts{hostId:{reserve}}}               — stored energy in U per powered host
//
// powerStatus is the one power query: allocation, admission, the integrator, the HUD, the strip
// and notices all read it (A-02, PF-10). Tiers: mandatory → baseline → process → reserve.
//
//   • Baseline is drawn by every online unit of an operational machine, running or not, in
//     whole units, banks in installation order (bank id).
//   • Zero-power runs are not electrical loads: speed 1, never NO_POWER, never refused.
//   • Full mode — the reserve is positive, or generation covers the full demand (mandatory +
//     every baseline unit + every powered run): every unit is online and every powered run
//     gets its full rate; the reserve moves by the balance, clamped to [0, capacity].
//   • Direct mode — the reserve is empty and the full demand is not covered: mandatory first,
//     then whole baseline units in bank order, then powered runs share what is left in run order
//     (min(rate, left)); any remainder too small to use is curtailed, so the reserve never
//     flickers between empty and charging (S-44). With no baseline this is exactly the
//     elastic S-12 rule.
// No run reserves energy and no lease is stored (PF-13). The raw balance and any mandatory
// shortfall are reported apart from the actual reserve movement, which can never take the
// reserve below 0 or above capacity.
import { check, isObj, isFiniteNum, has } from '../core/shape.js';
import { requireSlice } from '../core/state.js';
import { generationAt, storageAt, powerDef, banksAt, isOperational } from './equipment.js';

const EPS = 1e-12;
const idNumber = id => Number(id.slice(id.lastIndexOf('.') + 1));

/** Ids in creation order (`prefix.N`): accepted runs, banks. */
export const creationOrder = ids => [...ids].sort((a, b) => idNumber(a) - idNumber(b));

/** Accepted runs in allocation order (run creation order). */
export const runOrder = runs => creationOrder(Object.keys(runs));

/** The one power query for a host. Pure. Returns null for hosts without facility power. */
export function powerStatus(state, geography, content, hostId) {
  const host = state.power?.hosts?.[hostId];
  const def = powerDef(state, content, hostId);
  if (!host || !def) return null;
  const generation = generationAt(state, content, hostId);
  const capacity = storageAt(state, content, hostId);
  const reserve = host.reserve;
  const mandatoryDemand = def.mandatoryLoad;

  // Machines: operational banks draw baseline per online unit.
  const bankMap = Object.fromEntries(banksAt(state, hostId));
  const banks = creationOrder(Object.keys(bankMap)).map(bankId => {
    const b = bankMap[bankId], rate = content.equipment[b.model].baseline ?? 0;
    return { bankId, units: isOperational(b) ? b.quantity : 0, online: 0, baseline: rate, operational: isOperational(b) };
  });
  const byBank = Object.fromEntries(banks.map(b => [b.bankId, b]));
  const all = state.work?.runs ?? {};
  const hostRuns = runOrder(all).filter(id => all[id].hostId === hostId);
  // A run at a machine needs that machine operational; manual runs need nothing.
  const eligible = id => !all[id].bankId || byBank[all[id].bankId]?.operational === true;
  const baselineRequested = banks.reduce((n, b) => n + b.units * b.baseline, 0);
  const processRequested = hostRuns.filter(eligible).reduce((n, id) => n + (all[id].powerRate > 0 ? all[id].powerRate : 0), 0);
  const fullBalance = generation - mandatoryDemand - baselineRequested - processRequested;
  const direct = reserve <= 0 && fullBalance < -EPS;

  let mandatoryServed = mandatoryDemand, left = Infinity;
  if (direct) { mandatoryServed = Math.min(mandatoryDemand, generation); left = Math.max(0, generation - mandatoryDemand); }
  let baselineServed = 0;
  for (const b of banks) {
    if (!direct || b.baseline <= 0) b.online = b.units;
    else { b.online = Math.min(b.units, Math.floor(left / b.baseline + 1e-9)); left = Math.max(0, left - b.online * b.baseline); }
    baselineServed += b.online * b.baseline;
  }
  // Each machine's online units serve its runs in run order; later runs wait OFFLINE.
  const seat = Object.fromEntries(banks.map(b => [b.bankId, b.online]));
  let processAllocated = 0;
  const runs = [];
  for (const runId of hostRuns) {
    const r = all[runId];
    if (r.bankId) {
      if (!eligible(runId)) { runs.push({ runId, speed: 0, powered: r.powerRate > 0, blocker: 'DISABLED' }); continue; }
      if (seat[r.bankId] <= 0) { runs.push({ runId, speed: 0, powered: r.powerRate > 0, blocker: 'OFFLINE' }); continue; }
      seat[r.bankId] -= 1;
    }
    if (!(r.powerRate > 0)) { runs.push({ runId, speed: 1, powered: false, blocker: null }); continue; }
    const allocation = direct ? Math.min(r.powerRate, left) : r.powerRate;
    if (direct) left -= allocation;
    processAllocated += allocation;
    const speed = allocation / r.powerRate;
    runs.push({ runId, speed, powered: true, blocker: speed < 1 ? 'NO_POWER' : null });
  }
  const mandatoryShortfall = mandatoryDemand - mandatoryServed;
  const balance = generation - mandatoryDemand - baselineServed - processAllocated;
  let reserveRate, curtailed = 0;
  if (direct) { reserveRate = 0; curtailed = Math.max(0, left); }
  else if (reserve >= capacity) { reserveRate = Math.min(0, balance); curtailed = Math.max(0, balance); }
  else reserveRate = balance;
  if (Math.abs(reserveRate) < EPS) reserveRate = 0;
  if (curtailed < EPS) curtailed = 0;
  const unitsOffline = banks.some(b => b.online < b.units);
  let status;
  if (mandatoryShortfall > EPS) status = 'brownout';
  else if (direct && (unitsOffline || runs.some(r => r.powered && r.speed < 1))) status = 'limited';
  else if (reserveRate > 0) status = 'charging';
  else if (reserveRate < 0) status = 'draining';
  else if (reserve > 0 && reserve >= capacity) status = 'full';
  else status = 'balanced';
  return {
    hostId, generation, mandatoryDemand, mandatoryServed, mandatoryShortfall, mandatoryLabel: def.mandatoryLabel ?? 'Mandatory load',
    baselineRequested, baselineServed, processRequested, processAllocated, balance, reserveRate, curtailed, reserve, capacity,
    mode: direct ? 'direct' : 'full', state: status,
    secondsToEmpty: reserveRate < 0 ? reserve / -reserveRate : null, runs,
    banks: banks.map(({ bankId, units, online, baseline }) => ({ bankId, units, online, baseline }))
  };
}

/**
 * The allocation every accepted run should have now: runId → speed (0..1). Runs at hosts
 * without facility power get speed 1 when they draw nothing and 0 otherwise.
 */
export function allocation(state, geography, content) {
  const out = {};
  const hosts = new Set(Object.values(state.work?.runs ?? {}).map(r => r.hostId));
  for (const hostId of hosts) {
    const ps = powerStatus(state, geography, content, hostId);
    if (ps) for (const r of ps.runs) out[r.runId] = r.speed;
  }
  for (const [runId, r] of Object.entries(state.work?.runs ?? {})) if (!has(out, runId)) out[runId] = r.powerRate > 0 ? 0 : 1;
  return out;
}

/** The earliest reserve boundary (empty or full) after now: {t, hosts:[hostId]} or {t: Infinity}. */
export function nextPowerBoundary(state, geography, content) {
  const now = state.meta.simulationTime;
  let t = Infinity, hosts = [];
  for (const hostId of Object.keys(state.power?.hosts ?? {})) {
    const ps = powerStatus(state, geography, content, hostId);
    if (!ps) continue;
    let at = Infinity;
    if (ps.reserve > 0 && ps.reserveRate < 0) at = now + ps.reserve / -ps.reserveRate;
    else if (ps.reserveRate > 0 && ps.reserve < ps.capacity) at = now + (ps.capacity - ps.reserve) / ps.reserveRate;
    if (at < t) { t = at; hosts = [hostId]; } else if (at === t && at !== Infinity) hosts.push(hostId);
  }
  return { t, hosts };
}

/**
 * Integrate every host's reserve over Δ at the step's fixed allocation (called by the
 * integrator before the clock moves). Hosts whose boundary is the step's end snap exactly
 * to 0 or capacity; values never leave [0, capacity].
 */
export function advancePower(candidate, geography, content, dt, snapHosts = []) {
  const snap = new Set(snapHosts);
  for (const hostId of Object.keys(candidate.power.hosts)) {
    const ps = powerStatus(candidate, geography, content, hostId);
    if (!ps) continue;
    let r = ps.reserve + ps.reserveRate * dt;
    if (snap.has(hostId)) r = ps.reserveRate < 0 ? 0 : ps.capacity;
    candidate.power.hosts[hostId].reserve = Math.min(ps.capacity, Math.max(0, r));
  }
}

/** Create facility power for every authored site that declares it (world creation only). */
export function initializePower(candidate, { geography, content }) {
  check(!has(candidate, 'power'), 'power already exists');
  check(has(candidate, 'equipment'), 'power needs equipment to be initialized first');
  candidate.power = { hosts: {} };
  for (const key of Object.keys(geography.anchors).sort()) {
    const def = content.world.sites[key]?.power;
    if (!def) continue;
    const id = geography.anchors[key];
    const capacity = storageAt(candidate, content, id);
    check(def.initialReserve >= 0 && def.initialReserve <= capacity, `site ${key} initial reserve exceeds its storage`);
    candidate.power.hosts[id] = { reserve: def.initialReserve };
  }
  requireSlice(candidate, 'power');
}

export function validatePower(state, geography, content) {
  const p = state.power;
  check(isObj(p) && Object.keys(p).join() === 'hosts' && isObj(p.hosts), 'power must be exactly {hosts}');
  for (const [hostId, h] of Object.entries(p.hosts)) {
    check(powerDef(state, content, hostId), `power host ${hostId} has no facility power definition`);
    check(isObj(h) && Object.keys(h).join() === 'reserve' && isFiniteNum(h.reserve), `power host ${hostId} must be exactly {reserve}`);
    const capacity = storageAt(state, content, hostId);
    check(h.reserve >= 0 && h.reserve <= capacity + 1e-9, `power host ${hostId} reserve must be 0..${capacity}`);
  }
}
