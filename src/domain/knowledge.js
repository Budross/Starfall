// Player knowledge (Habitat05_01 §5, S-22, S-25, S-47, S-52). Sole writer of the `knowledge` slice.
//
//   facets{id: {seen?, identified?, surveyed?}}       — independent, source-aware records {at, source}
//   places{placeRef: {known?, observedAt?, observed?}} — observed: the remembered room, {topic: value}
//   evidence{subjectRef: {completedAt}}                 — one-time completion per evidence source
//   fragments{fragmentId: {at, source}}                 — narrative fragments (never research discoveries)
//   reports{vesselId: {at, via, position, status, heading, hostId}}   — latest observation of each vessel
//   items{itemId: {at, facts: [key]}}                   — item knowledge (add-only)
//
// Everything the character learns automatically is learned here, in notice(), at the end of
// every transaction (PF-02). `seen` records detection; current visibility itself is derived,
// never stored. A vessel report is overwritten only while the vessel is observed; otherwise it
// ages as last-known. The room the character occupies is observed continuously (S-47): on
// entering it, the delta reports what changed since it was last seen; while present, only a
// newly perceivable subject is reported, and every other change is absorbed silently. Item
// knowledge facts are only ever added (S-52).
import { check, isObj, isFiniteNum, isVec3, isSafeId, has, CommandError } from '../core/shape.js';
import { append } from '../rules/ledger.js';
import { compileEffects, preflightEffects, applyEffects } from '../rules/effects.js';
import { permissionReason } from '../rules/authority.js';
import { placeRef, subjectRef, parseRef, siteOf, authoredSite, visibleNow, observablesAt, stationaryIds, vesselIds, positionOf, vesselDirection, conditionHolds } from './world.js';
import { banksAt } from './equipment.js';
import { holdOf } from './inventory.js';
import { leaseOf } from './work.js';
import { machineStatus } from './orders.js';
import { PLAYER } from './entities.js';

export const FACETS = Object.freeze(['seen', 'identified', 'surveyed']);
export const SOURCES = Object.freeze(['visual', 'sensor', 'prior-record', 'evidence']);
export const REPORT_VIA = Object.freeze(['visual', 'local-berth']);
export const REPORT_STATUS = Object.freeze(['moving', 'holding', 'docked']);
export const DEPOSIT_WORDS = Object.freeze(['available', 'low', 'depleted']);
export const MACHINE_WORDS = Object.freeze(['running', 'power-limited', 'offline', 'disabled', 'starved', 'idle']);
const PLACE_FIELDS = new Set(['known', 'observedAt', 'observed']);
const REPORT_FIELDS = ['at', 'heading', 'hostId', 'position', 'status', 'via'];
const OBSERVED_STATUS = { transit: 'moving', holding: 'holding', docked: 'docked' };
const LIST_LIMIT = 16;
const FACT_LIMIT = 64;

/** The knowledge delta of a transaction that observed nothing. */
export const emptyDelta = () => ({ newlySeen: [], reportChanges: [], arrival: null, newlyPerceived: [], itemsLearned: [] });

export function initialKnowledge(content, geography) {
  const k = { facets: {}, places: {}, evidence: {}, fragments: {}, reports: {}, items: {} };
  const record = { at: 0, source: 'prior-record' };
  for (const r of content.world.priorRecords) {
    if (r.subject) {
      const id = geography.anchors[r.subject];
      (k.facets[id] ??= {})[r.facet] = { ...record };
    } else if (r.place) {
      const [siteKey, placeKey] = r.place;
      k.places[placeRef(geography.anchors[siteKey], placeKey)] = { known: { ...record } };
    }
  }
  return k;
}

// ---------------------------------------------------------------- room observation (S-47, S-48)

/** Deposit wording (S-48): above the low fraction 'available', above 0 'low', 0 'depleted'. */
export function depositWord(remaining, initial, lowFraction) {
  if (!(remaining > 0)) return 'depleted';
  return remaining > initial * lowFraction ? 'available' : 'low';
}

/** A bank's remembered value: physical condition and status are independent (S-47). */
const bankValue = b => `${b.health < 1 ? 'damaged' : 'intact'}/${b.quantity > 0 && b.health > 0 ? 'operational' : 'not-operational'}/${b.quantity}`;
const machineWord = status => status.toLowerCase().replace(' ', '-');

/**
 * What the character perceives in a room right now, as coarse discrete values (pure):
 *   subject:<key> → condition · deposit:<itemId> → available|low|depleted
 *   bank:<bankId> → <intact|damaged>/<operational|not-operational>/<qty> · machine:<bankId> → state word
 */
export function perceivedAt(state, geography, content, hostId, placeKey) {
  const out = {};
  for (const o of observablesAt(state, geography, content, hostId, placeKey)) out[`subject:${o.key}`] = o.condition ?? 'present';
  const site = authoredSite(state, content, hostId), geo = siteOf(state, geography, hostId);
  for (const [itemId, dep] of Object.entries(site?.deposits ?? {})) {
    if (dep.placeKey !== placeKey) continue;
    const nodeId = `${state.entities[hostId].authoredId}.${itemId}`;
    const initial = geo?.deposits?.[nodeId]?.initial;
    if (!initial) continue;
    out[`deposit:${itemId}`] = depositWord(state.deposits?.remaining?.[nodeId] ?? 0, initial, content.observation.depositLowFraction);
  }
  for (const [bankId, b] of banksAt(state, hostId, placeKey)) {
    out[`bank:${bankId}`] = bankValue(b);
    if (content.equipment[b.model]?.processes) out[`machine:${bankId}`] = machineWord(machineStatus(state, geography, content, bankId).status);
  }
  return out;
}

/**
 * Observe the room the character occupies (S-47). On arrival (no previous presence, or a
 * different room) the delta carries what is new or changed since the room was last seen;
 * while present only newly perceivable subjects are reported. Missing topics are not
 * comparable, never "absent". A ledger entry is written only for a reported change.
 */
function observePlace(candidate, geography, content, previous, delta) {
  const { hostId, placeId } = candidate.actor;
  if (!siteOf(candidate, geography, hostId)?.places?.[placeId]) return;
  const at = candidate.meta.simulationTime;
  const ref = placeRef(hostId, placeId);
  const now = perceivedAt(candidate, geography, content, hostId, placeId);
  const rec = candidate.knowledge.places[ref] ??= {};
  const prev = rec.observed ?? null;
  const arrived = !previous || previous.hostId !== hostId || previous.placeId !== placeId;
  let noticed = [], changed = [], report = false;
  if (arrived) {
    noticed = Object.keys(now).filter(t => !prev || !has(prev, t));
    changed = prev ? Object.keys(now).filter(t => has(prev, t) && prev[t] !== now[t]).map(t => ({ topic: t, from: prev[t], to: now[t] })) : [];
    delta.arrival = { placeRef: ref, first: !prev, noticed, changed };
    report = !prev || noticed.length > 0 || changed.length > 0;
  } else if (prev) {
    noticed = Object.keys(now).filter(t => t.startsWith('subject:') && !has(prev, t));
    delta.newlyPerceived = noticed;
    report = noticed.length > 0;
  }
  rec.observed = now;
  rec.observedAt = at;
  rec.known ??= { at, source: 'visual' };
  if (report) append(candidate, 'PLACE_OBSERVATION_CHANGED', { placeRef: ref, noticed: noticed.slice(0, LIST_LIMIT), changed: changed.map(c => c.topic).slice(0, LIST_LIMIT) });
  // Bounded memory: evict the longest-unseen room; its next entry counts as a first visit.
  const remembered = Object.entries(candidate.knowledge.places).filter(([, r]) => r.observed);
  if (remembered.length > content.observation.placeLimit) {
    const [oldest] = remembered.filter(([r]) => r !== ref).sort(([, a], [, b]) => a.observedAt - b.observedAt)[0];
    delete candidate.knowledge.places[oldest].observed;
    delete candidate.knowledge.places[oldest].observedAt;
  }
}

// ---------------------------------------------------------------- item knowledge (S-52, R-07)

/**
 * Learn about items from what the character encountered and understands (add-only). An entry
 * that does not come from an encounter needs the item's own unlock (R-04). Learning never
 * gates any action.
 */
function learnItems(candidate, geography, content, completed, delta) {
  const s = candidate, { hostId, placeId } = s.actor;
  const at = s.meta.simulationTime, items = s.knowledge.items;
  const known = itemId => has(items, itemId) || conditionHolds(s, geography, content, content.items[itemId].unlock, 'unlock');
  const add = (itemId, fact = null) => {
    if (!has(items, itemId)) { items[itemId] = { at, facts: [] }; delta.itemsLearned.push(itemId); }
    const e = items[itemId];
    if (fact && !e.facts.includes(fact)) { e.facts.push(fact); e.facts.sort(); }
  };
  // Encounters: held cargo aboard (with facility access), equipment in this room, the
  // character's own work in progress, and every run the character completed in this transaction.
  if (!permissionReason(s, PLAYER, hostId, 'useFacilities')) for (const itemId of Object.keys(holdOf(s, hostId))) add(itemId);
  for (const [, b] of banksAt(s, hostId, placeId)) { const item = content.equipment[b.model]?.item; if (item) add(item); }
  const lease = leaseOf(s, PLAYER);
  if (lease) for (const itemId of Object.keys(lease.run.outputs)) add(itemId);
  for (const { run } of completed) if (run.actorId === PLAYER) for (const itemId of Object.keys(run.outputs)) add(itemId);
  // Sources: deposits worked in this room.
  for (const [itemId, dep] of Object.entries(authoredSite(s, content, hostId)?.deposits ?? {})) if (dep.placeKey === placeId) add(itemId, `source:${hostId}/${placeId}`);
  // Recipes the character understands.
  for (const [rid, r] of Object.entries(content.recipes)) {
    if (!conditionHolds(s, geography, content, r.unlock, 'unlock')) continue;
    if (known(r.output)) add(r.output, `madeBy:${rid}`);
    for (const slot of r.inputs) for (const o of slot.item ? [slot.item] : slot.anyOf) if (known(o)) add(o, `usedIn:${rid}`);
  }
  // Processes of machines installed aboard that the character understands.
  for (const [, b] of banksAt(s, hostId)) {
    for (const [pid, p] of Object.entries(content.equipment[b.model]?.processes ?? {})) {
      if (!conditionHolds(s, geography, content, p.unlock, 'unlock')) continue;
      const key = `${b.model}/${pid}`;
      if (p.kind === 'extract') { if (known(p.deposit)) add(p.deposit, `processOut:${key}`); continue; }
      for (const id of Object.keys(p.inputs)) if (known(id)) add(id, `processIn:${key}`);
      for (const id of Object.keys(p.outputs)) if (known(id)) add(id, `processOut:${key}`);
    }
  }
  // Authored notes on known items.
  for (const itemId of Object.keys(items)) {
    for (const [noteId, n] of Object.entries(content.items[itemId]?.notes ?? {})) {
      const when = n.learnWhen ?? { onEncounter: true };
      if (when.onEncounter === true || (when.conditions && conditionHolds(s, geography, content, when.conditions, 'unlock'))) add(itemId, `note:${noteId}`);
    }
  }
}

/**
 * Automatic detection at the end of every transaction: record `seen` for everything newly
 * visible, overwrite the report of every vessel observed right now, observe the occupied room
 * and learn about items. Returns the knowledge delta written — the only system-to-player
 * channel (observer.projectNotices):
 *   {newlySeen, reportChanges, arrival, newlyPerceived, itemsLearned}
 * `previous` is the actor of the previous committed state (null at world creation);
 * `completed` is every run the transaction completed. An event nobody observed changes no
 * knowledge, so it yields no delta.
 */
export function notice(candidate, geography, content, { previous = null, completed = [] } = {}) {
  const at = candidate.meta.simulationTime;
  const delta = emptyDelta();
  const visible = visibleNow(candidate, geography, content);
  for (const id of visible) {
    const f = candidate.knowledge.facets[id] ??= {};
    if (!f.seen) { f.seen = { at, source: 'visual' }; delta.newlySeen.push(id); }
  }
  const reports = candidate.knowledge.reports;
  for (const id of vesselIds(candidate)) {
    const v = candidate.vessels[id];
    const atHost = v.status === 'docked' && v.hostId === candidate.actor.hostId;
    if (!atHost && !visible.has(id)) continue;
    const status = OBSERVED_STATUS[v.status];
    // The docked host is part of the sighting only if the character has seen that host.
    const hostId = v.status === 'docked' && candidate.knowledge.facets[v.hostId]?.seen ? v.hostId : null;
    const prev = reports[id];
    reports[id] = { at, via: atHost ? 'local-berth' : 'visual', position: { ...positionOf(candidate, geography, id) }, status, heading: vesselDirection(v), hostId };
    if (!prev || prev.status !== status || prev.hostId !== hostId) delta.reportChanges.push({ id, from: prev?.status ?? null, to: status, hostId });
  }
  observePlace(candidate, geography, content, previous, delta);
  learnItems(candidate, geography, content, completed, delta);
  return delta;
}

/** Effect target: grant a narrative fragment once. Returns false if already held. */
export function grantFragment(candidate, fragmentId, source = null) {
  if (has(candidate.knowledge.fragments, fragmentId)) return false;
  candidate.knowledge.fragments[fragmentId] = { at: candidate.meta.simulationTime, source };
  return true;
}

function requirePresence(candidate, hostId, placeKey) {
  const a = candidate.actor;
  if (a.hostId !== hostId || a.placeId !== placeKey) throw new CommandError('You can only do that in the compartment you are in.', 'access');
}

/**
 * Examine an evidence subject the character can perceive (S-25). One-time effects belong
 * to the evidence source and are applied once, with a persistent completion record.
 */
export function examine(candidate, ctx, { targetId, placeId, subjectKey }) {
  requirePresence(candidate, targetId, placeId);
  const { geography, content } = ctx;
  const o = observablesAt(candidate, geography, content, targetId, placeId).find(s => s.key === subjectKey);
  if (!o) throw new CommandError('You do not see that here.', 'access');
  if (o.kind !== 'evidence') throw new CommandError(`There is nothing to examine on the ${o.label}.`, 'request');
  const def = authoredSite(candidate, content, targetId).places[placeId].subjects[subjectKey];
  const ref = subjectRef(targetId, placeId, subjectKey);
  if (has(candidate.knowledge.evidence, ref)) {
    return { kind: 'EVIDENCE_REVIEWED', message: `You re-read the ${o.label}. ${def.reading ?? ''}`.trim(), changes: {} };
  }
  const effects = compileEffects(def.effects ?? []);
  const effectCtx = { ...ctx, sourceRef: ref };
  preflightEffects(candidate, effects, effectCtx);
  applyEffects(candidate, effects, effectCtx);
  candidate.knowledge.evidence[ref] = { completedAt: candidate.meta.simulationTime };
  append(candidate, 'EVIDENCE_EXAMINED', { subjectRef: ref });
  return { kind: 'EVIDENCE_EXAMINED', message: `You examine the ${o.label}. ${def.reading ?? ''}`.trim(), changes: { evidence: [ref] } };
}

// ---------------------------------------------------------------- validation

const stamp = (r, sources, what) => check(isObj(r) && isFiniteNum(r.at) && r.at >= 0 && sources.includes(r.source), `${what} must be {at, source}`);

/** Whether a remembered topic resolves at this place and its value is in its vocabulary. */
function validTopic(state, content, p, place, topic, value) {
  const i = topic.indexOf(':');
  const kind = topic.slice(0, i), key = topic.slice(i + 1);
  if (typeof value !== 'string' || !value) return false;
  if (kind === 'subject') return place.subjects.includes(key);
  if (kind === 'deposit') return authoredSite(state, content, p.hostId)?.deposits?.[key]?.placeKey === p.placeKey && DEPOSIT_WORDS.includes(value);
  if (kind === 'bank') return isSafeId(key) && /^(intact|damaged)\/(operational|not-operational)\/\d+$/.test(value);
  if (kind === 'machine') return isSafeId(key) && MACHINE_WORDS.includes(value);
  return false;
}

/** Whether an item-knowledge fact key resolves for this item. */
function validFact(state, content, itemId, fact) {
  const i = fact.indexOf(':');
  const kind = fact.slice(0, i), key = fact.slice(i + 1);
  if (kind === 'madeBy') return content.recipes[key]?.output === itemId;
  if (kind === 'usedIn') return (content.recipes[key]?.inputs ?? []).some(slot => (slot.item ? [slot.item] : slot.anyOf).includes(itemId));
  if (kind === 'processIn' || kind === 'processOut') {
    const [model, pid] = key.split('/');
    const p = content.equipment[model]?.processes?.[pid];
    if (!p) return false;
    if (kind === 'processIn') return p.kind === 'refine' && has(p.inputs, itemId);
    return p.kind === 'extract' ? p.deposit === itemId : has(p.outputs, itemId);
  }
  if (kind === 'source') {
    const r = parseRef(key);
    return !!r && r.subjectKey === undefined && authoredSite(state, content, r.hostId)?.deposits?.[itemId]?.placeKey === r.placeKey;
  }
  if (kind === 'note') return has(content.items[itemId]?.notes ?? {}, key);
  return false;
}

export function validateKnowledge(state, geography, content) {
  const k = state.knowledge;
  check(isObj(k) && Object.keys(k).sort().join() === 'evidence,facets,fragments,items,places,reports', 'knowledge must be exactly {facets, places, evidence, fragments, reports, items}');
  const known = new Set([...stationaryIds(state, geography), ...Object.keys(state.entities)]);
  for (const [id, f] of Object.entries(k.facets)) {
    check(known.has(id), `knowledge facet for unknown object ${id}`);
    check(isObj(f), `facets for ${id} must be an object`);
    for (const [name, r] of Object.entries(f)) {
      check(FACETS.includes(name), `unknown facet ${name}`);
      stamp(r, SOURCES, `facet ${name} of ${id}`);
      check(r.at <= state.meta.simulationTime, `facet ${name} of ${id} is in the future`);
    }
  }
  const { placeLimit, topicLimit } = content.observation;
  let remembered = 0;
  for (const [ref, rec] of Object.entries(k.places)) {
    const p = parseRef(ref);
    const place = p && p.subjectKey === undefined ? siteOf(state, geography, p.hostId)?.places?.[p.placeKey] : null;
    check(place, `knowledge place ${ref} does not resolve`);
    check(isObj(rec) && Object.keys(rec).every(f => PLACE_FIELDS.has(f)), `knowledge place ${ref} has unknown fields`);
    if (rec.known) stamp(rec.known, SOURCES, `place ${ref} known`);
    check((rec.observed === undefined) === (rec.observedAt === undefined), `place ${ref} observation must carry its time`);
    if (rec.observed !== undefined) {
      remembered += 1;
      check(isFiniteNum(rec.observedAt) && rec.observedAt >= 0 && rec.observedAt <= state.meta.simulationTime, `place ${ref} observedAt invalid`);
      check(isObj(rec.observed) && Object.keys(rec.observed).length <= topicLimit, `place ${ref} observation invalid or over ${topicLimit} topics`);
      for (const [topic, value] of Object.entries(rec.observed)) check(validTopic(state, content, p, place, topic, value), `observation ${topic} of ${ref} invalid`);
    }
  }
  check(remembered <= placeLimit, `more than ${placeLimit} remembered rooms`);
  for (const [ref, rec] of Object.entries(k.evidence)) {
    const p = parseRef(ref);
    const place = p?.subjectKey ? siteOf(state, geography, p.hostId)?.places?.[p.placeKey] : null;
    check(place && place.subjects.includes(p.subjectKey), `evidence record ${ref} does not resolve`);
    const def = authoredSite(state, content, p.hostId)?.places?.[p.placeKey]?.subjects?.[p.subjectKey];
    check(def?.kind === 'evidence', `evidence record ${ref} is not an evidence source`);
    check(isObj(rec) && isFiniteNum(rec.completedAt) && rec.completedAt <= state.meta.simulationTime, `evidence record ${ref} invalid`);
  }
  for (const [id, rec] of Object.entries(k.fragments)) {
    check(has(content.fragments, id), `unknown fragment ${id}`);
    check(isObj(rec) && isFiniteNum(rec.at) && (rec.source === null || typeof rec.source === 'string'), `fragment ${id} record invalid`);
  }
  check(isObj(k.reports), 'knowledge.reports must be an object');
  for (const [id, r] of Object.entries(k.reports)) {
    check(state.entities[id]?.kind === 'vessel', `report for unknown vessel ${id}`);
    check(isObj(r) && Object.keys(r).sort().join() === REPORT_FIELDS.join(), `report ${id} must be exactly {${REPORT_FIELDS.join(', ')}}`);
    check(isFiniteNum(r.at) && r.at >= 0 && r.at <= state.meta.simulationTime, `report ${id} time invalid`);
    check(REPORT_VIA.includes(r.via) && REPORT_STATUS.includes(r.status), `report ${id} via/status invalid`);
    check(isVec3(r.position), `report ${id} position invalid`);
    check(r.heading === null || (isVec3(r.heading) && Math.abs(Math.hypot(r.heading.x, r.heading.y, r.heading.z) - 1) < 1e-6), `report ${id} heading must be a unit vector or null`);
    check(r.hostId === null || (r.status === 'docked' && siteOf(state, geography, r.hostId)), `report ${id} host invalid`);
  }
  check(isObj(k.items), 'knowledge.items must be an object');
  for (const [itemId, e] of Object.entries(k.items)) {
    check(has(content.items, itemId), `item knowledge for unknown item ${itemId}`);
    check(isObj(e) && Object.keys(e).sort().join() === 'at,facts' && isFiniteNum(e.at) && e.at >= 0 && e.at <= state.meta.simulationTime, `item knowledge ${itemId} invalid`);
    check(Array.isArray(e.facts) && e.facts.length <= FACT_LIMIT && e.facts.every((f, i) => typeof f === 'string' && (i === 0 || e.facts[i - 1] < f)), `item knowledge ${itemId} facts must be sorted and unique`);
    for (const f of e.facts) check(validFact(state, content, itemId, f), `item knowledge ${itemId} fact ${f} does not resolve`);
  }
}
