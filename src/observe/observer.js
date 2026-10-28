// Observer (Habitat05_03 §5.1): the only path from committed truth to any surface.
// Map entities, context panels, the HUD, workspaces and SceneViews are built here from the
// character's knowledge, presence and authority — never from raw truth (K-01).
//
// Display ids are opaque and per session (d01, d02, …); canonical ids never leave this
// module. All functions are pure over (state, geography): they never mutate (Z-04).
// Stage 4 adds facility power, storage, personal work and research projections; the industrial
// stage adds installed machines, their orders and operating states (machineStatus), slots and
// installation. Every power figure comes from powerStatus and every storage figure from
// storageStatus (A-02, A-05); no undiscovered discovery, recipe or item appears anywhere (R-04).
import { has } from '../core/shape.js';
import { visibleNow, siteOf, authoredSite, stationaryIds, vesselIds, conditionHolds } from '../domain/world.js';
import { hasPermission } from '../rules/authority.js';
import { PLAYER } from '../domain/entities.js';
import { quote } from '../domain/vessels.js';
import { powerStatus } from '../domain/power.js';
import { storageStatus, formatQty, heldQty, claimable, holdOf } from '../domain/inventory.js';
import { banksAt, bankLabel, repairDef, isOperational, capabilitiesAt, installPreflight, repairPreflight, togglePreflight, slotsAt, placementReason } from '../domain/equipment.js';
import { preflightWork, leaseOf, runLabel, endsAt, remainingAt, craftKind, abortPreflight, runsAtBank } from '../domain/work.js';
import { machineStatus, orderOf, orderPreflight, stopPreflight, MAX_ORDER_COUNT } from '../domain/orders.js';
import { moveBlocker } from '../domain/movement.js';
import { researchCatalog, previewExperiment, usefulSamples, sampleCost, studyPreview } from '../domain/research.js';
import { parseRef } from '../domain/world.js';
import { datum } from './charts.js';

const TYPE_WORD = { station: 'station', asteroid: 'asteroid', megastructure: 'megastructure', ship: 'vessel' };
const GENERIC_LABEL = { station: 'UNIDENTIFIED STATION', asteroid: 'UNSURVEYED BODY', megastructure: 'UNKNOWN STRUCTURE', ship: 'UNIDENTIFIED VESSEL' };
const GENERIC_DESC = {
  station: 'A station whose designation you have not confirmed.',
  asteroid: 'Deposit estimates are unavailable until surveyed.',
  megastructure: 'An enormous engineered silhouette. Its purpose, condition and history are not known.',
  ship: 'A vessel you have not identified.'
};
const REPORT_TEXT = { moving: 'Moving under its own power.', holding: 'Holding position in open space.', docked: 'Docked.' };
const POWER_WORD = { charging: 'charging', draining: 'draining', full: 'full', balanced: 'balanced', limited: 'work slowed', brownout: 'brownout' };

/** "12 s ago", "3 min ago", "2 h ago". */
export function ageText(seconds) {
  const s = Math.max(0, seconds);
  if (s < 60) return `${Math.round(s)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}
const MEGA_COLOR = { color: '#42d8e0', colorFill: '#1d7c8121' };
/** Scene actions that require the character's physical presence. */
export const isPresenceAction = id => id === 'cancel-work' || /^(examine|move|collect|repair|install|study):/.test(id);

const titleCase = s => s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
const sentence = s => s ? s[0].toUpperCase() + s.slice(1) : s;
const rate = v => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)} U/s`;
const units = v => `${Math.round(v * 10) / 10}`;

/** Remote and recorded perspectives never carry presence-only actions (SC-05). */
export function filterActionsForPerspective(actions, perspective) {
  return perspective === 'physical' ? actions : actions.filter(a => !isPresenceAction(a.id));
}

export function createObserver(content) {
  const toDisplay = new Map(), toCanonical = new Map();
  const did = id => {
    if (!toDisplay.has(id)) {
      const d = `d${String(toDisplay.size + 1).padStart(2, '0')}`;
      toDisplay.set(id, d); toCanonical.set(d, id);
    }
    return toDisplay.get(id);
  };
  const resolve = d => toCanonical.get(d) ?? null;
  const ctxOf = geography => ({ actorId: PLAYER, geography, content });

  function typeOf(geography, state, id) {
    if (has(geography.bodies, id)) return 'asteroid';
    if (has(geography.megastructures, id)) return 'megastructure';
    if (has(geography.sites, id) || has(state.sites, id)) return 'station';
    if (state.entities[id]?.kind === 'vessel') return 'ship';
    return null;
  }
  const facets = (state, id) => state.knowledge.facets[id] ?? {};
  const identified = (state, id) => !!facets(state, id).identified;
  /** The character's latest observation of a vessel, and whether it is current. */
  const reportOf = (state, id) => state.knowledge.reports[id] ?? null;
  const isLive = (state, r) => !!r && r.at === state.meta.simulationTime;
  const commands = (state, id) => hasPermission(state, PLAYER, id, 'command');
  /**
   * Objects the character knows to exist: stationary objects seen before (fixed positions)
   * or visible now; vessels only through a report (live or last-known), never from truth.
   */
  function displayable(state, geography) {
    const now = visibleNow(state, geography, content);
    return [
      ...stationaryIds(state, geography).filter(id => now.has(id) || facets(state, id).seen),
      ...vesselIds(state).filter(id => reportOf(state, id))
    ];
  }
  function labelOf(state, geography, id) {
    const type = typeOf(geography, state, id);
    if (identified(state, id)) {
      const key = state.entities[id]?.authoredId;
      const def = key && (content.world.sites[key] ?? content.world.megastructures[key] ?? content.world.vessels?.[key]);
      if (def?.label) return def.label.toUpperCase();
    }
    return GENERIC_LABEL[type];
  }
  function visibilityOf(state, id) {
    const f = facets(state, id);
    return f.surveyed ? 'surveyed' : f.identified ? 'identified' : 'signal';
  }
  const placeLabel = (state, hostId, placeKey) => authoredSite(state, content, hostId)?.places?.[placeKey]?.label ?? 'compartment';
  const itemLabel = id => content.items[id].label.toLowerCase();

  function projectMap(state, geography) {
    const ids = displayable(state, geography);
    const shown = new Set(ids);
    const routes = [];
    const entities = ids.map(id => {
      const type = typeOf(geography, state, id);
      const e = { id: did(id), type, label: labelOf(state, geography, id), visibility: visibilityOf(state, id) };
      if (type === 'ship') {
        // Position, heading and status come from the character's report, never from truth.
        const r = reportOf(state, id);
        e.position = { ...r.position };
        if (isLive(state, r)) { if (r.heading) e.direction = { ...r.heading }; }
        else e.presentation = { stale: true, ageText: `last seen ${ageText(state.meta.simulationTime - r.at)}` };
        // A journey the player commanded is known from the command itself (A-06).
        const v = state.vessels[id];
        if (commands(state, id) && v.status === 'transit' && v.journey.to.hostId && shown.has(v.journey.to.hostId)) routes.push({ from: e.id, to: did(v.journey.to.hostId) });
        return e;
      }
      if (type === 'megastructure') {
        const m = geography.megastructures[id];
        Object.assign(e, { position: { ...m.position }, authored: true, structure: structuredClone(m.footprint), ...MEGA_COLOR });
        return e;
      }
      const site = siteOf(state, geography, id), body = geography.bodies[id];
      e.position = { ...(site ?? body).position };
      if (body) e.scale = body.scale;
      const areaId = (site ?? body).areaId;
      const center = geography.areas[areaId]?.centerSite;
      if (center && center !== id && shown.has(center)) e.areaId = did(center);
      if (type === 'station' && identified(state, id)) e.authored = true;
      return e;
    });
    return { entities, routes, playerLocationId: did(state.actor.hostId) };
  }

  /** Context for a vessel: only what its report shows, plus the player's own commands. */
  function vesselContext(state, geography, id) {
    const r = reportOf(state, id);
    const live = isLive(state, r);
    const label = labelOf(state, geography, id);
    const mine = commands(state, id);
    const v = state.vessels[id];
    let description = REPORT_TEXT[r.status];
    if (r.status === 'docked' && r.hostId) description = `Docked at ${titleCase(labelOf(state, geography, r.hostId))}.`;
    if (mine && v.status === 'transit' && v.journey.to.hostId && displayable(state, geography).includes(v.journey.to.hostId)) {
      description += ` Under way to ${titleCase(labelOf(state, geography, v.journey.to.hostId))}, arriving in ${Math.max(0, Math.ceil(v.journey.arriveAt - state.meta.simulationTime))} s.`;
    } else if (r.status === 'moving') {
      description += ' Destination unknown — visual contact only.';
    }
    const actions = [];
    if (mine) {
      if (r.status === 'moving') actions.push({ id: 'cancel-journey', label: 'Cancel journey', kind: 'command' });
      if (r.status === 'holding' && v.nearHostId) actions.push({ id: 'dock-vessel', label: 'Dock', kind: 'command' });
      if (r.status === 'docked') actions.push({ id: 'undock-vessel', label: 'Undock', kind: 'command' });
    } else {
      actions.push({ id: 'command-vessel', label: 'Command vessel', kind: 'command', enabled: false, reason: 'You have no command authority over this vessel.' });
    }
    return {
      title: titleCase(label),
      kind: 'Vessel',
      knowledge: live ? (r.via === 'local-berth' ? 'Live · at your berth' : 'Live visual') : `Last seen ${ageText(state.meta.simulationTime - r.at)} · visual`,
      access: mine ? 'Under your command' : 'Remote observation',
      description,
      actions
    };
  }

  /** "Send <vessel> here" for each vessel the player commands that is holding. Uses the shared quote. */
  function sendHereActions(state, geography, hostId) {
    const out = [];
    for (const vid of vesselIds(state)) {
      if (!commands(state, vid) || reportOf(state, vid)?.status !== 'holding') continue;
      const q = quote(state, geography, content, vid, hostId);
      const preview = q.duration ? ` · ${Math.ceil(q.duration)} s · ${q.cost.energy.toFixed(1)} U` : '';
      out.push({ id: `send-vessel:${did(vid)}`, label: `Send ${titleCase(labelOf(state, geography, vid))} here${preview}`, kind: 'command', enabled: q.ok, ...(q.ok ? {} : { reason: q.reason }) });
    }
    return out;
  }

  // ---------------------------------------------------------------- Stage 4: local facilities

  const disabled = (p, extra = {}) => (p.ok ? { enabled: true, ...extra } : { enabled: false, reason: p.reason, category: p.category, ...extra });

  /** Go-to actions for each connected place (the keyboard path and the scene). */
  function moveActions(state, geography) {
    const host = siteOf(state, geography, state.actor.hostId);
    return host.places[state.actor.placeId].connections.map(placeKey => {
      const b = moveBlocker(state, ctxOf(geography), placeKey);
      return { id: `move:${placeKey}`, label: `Go to the ${placeLabel(state, state.actor.hostId, placeKey).toLowerCase()}`, kind: 'command', tone: 'move', ...(b ? { enabled: false, reason: b.reason, category: b.category } : { enabled: true }) };
    });
  }

  /** The character's own run, as the HUD and workspaces show it. */
  function workView(state) {
    const lease = leaseOf(state, PLAYER);
    if (!lease) return null;
    const r = lease.run, now = state.meta.simulationTime;
    const total = r.duration;
    const left = Math.max(0, remainingAt(r, now));
    const fraction = total > 0 ? Math.min(1, Math.max(0, 1 - left / total)) : 0;
    const end = endsAt(r);
    return { runId: did(lease.runId), label: runLabel(state, content, r), fraction, secondsLeft: Number.isFinite(end) ? Math.max(0, Math.ceil(end - now)) : null, paused: r.speed === 0, slowed: r.speed > 0 && r.speed < 1 };
  }

  /**
   * Presence actions for the place the character occupies (the place-interior scene).
   * `group: 'work'` (collect, repair, install, stop) is a presentation hint: the scene shows those in
   * its work rail. Install is offered only at places eligible for the product (S-36).
   */
  function placeActions(state, geography) {
    const { hostId, placeId } = state.actor;
    const ctx = ctxOf(geography);
    const site = authoredSite(state, content, hostId);
    const actions = [];
    for (const [itemId, dep] of Object.entries(site?.deposits ?? {})) {
      if (dep.placeKey !== placeId || !dep.collect) continue;
      const p = preflightWork(state, ctx, { kind: 'collect', itemId });
      const amount = p.ok ? formatQty(content, itemId, p.preview.outputs[itemId]) : formatQty(content, itemId, dep.collect.amount);
      actions.push({ id: `collect:${itemId}`, label: `Collect ${itemLabel(itemId)} · ${amount} · ${dep.collect.duration} s`, kind: 'command', group: 'work', ...disabled(p) });
    }
    for (const [bankId, b] of banksAt(state, hostId, placeId)) {
      const def = repairDef(content, b);
      if (!def || b.health >= 1) continue;
      const p = repairPreflight(state, ctx, { bankId });
      const known = conditionHolds(state, geography, content, def.unlock, 'unlock');
      const parts = known ? ` · ${Object.entries(def.inputs).map(([id, q]) => `${q} ${itemLabel(id)}${q > 1 ? 's' : ''}`).join(', ')}` : '';
      actions.push({ id: `repair:${did(bankId)}`, label: `Repair the ${bankLabel(content, b).toLowerCase()}${parts}`, kind: 'command', group: 'work', ...disabled(p) });
    }
    for (const itemId of Object.keys(holdOf(state, hostId)).sort()) {
      const modelId = content.items[itemId].installs;
      if (!modelId || placementReason(content, site, placeId, modelId)) continue;
      const p = installPreflight(state, ctx, { itemId });
      const slots = slotsAt(state, content, hostId, placeId);
      actions.push({ id: `install:${itemId}`, label: `Install the ${content.equipment[modelId].label.toLowerCase()} · slots ${slots.used}/${slots.total}`, kind: 'command', group: 'work', ...disabled(p) });
    }
    if (leaseOf(state, PLAYER)) actions.push({ id: 'cancel-work', label: `Stop: ${workView(state).label.toLowerCase()}`, kind: 'command', group: 'work', enabled: true });
    return [...actions, ...moveActions(state, geography)];
  }

  /** What the character perceives of facilities at this place (deposits and banks), as prose. */
  function placeFacilitiesText(state) {
    const { hostId, placeId } = state.actor;
    const parts = [];
    for (const [itemId, dep] of Object.entries(authoredSite(state, content, hostId)?.deposits ?? {})) {
      if (dep.placeKey !== placeId) continue;
      const nodeId = `${state.entities[hostId].authoredId}.${itemId}`;
      const left = state.deposits?.remaining?.[nodeId] ?? 0;
      parts.push(left > 0 ? `${sentence(dep.label ?? itemLabel(itemId))}: about ${formatQty(content, itemId, left)} of ${itemLabel(itemId)} left.` : `${sentence(dep.label ?? itemLabel(itemId))}: depleted.`);
    }
    for (const [, b] of banksAt(state, hostId, placeId)) {
      const cond = !isOperational(b) ? 'not operational' : b.health < 1 ? `damaged, ${Math.round(b.health * 100)} % effective` : 'operational';
      parts.push(`${sentence(bankLabel(content, b))}: ${cond}.`);
    }
    return parts.join(' ');
  }

  function powerLine(state, geography) {
    const ps = powerStatus(state, geography, content, state.actor.hostId);
    if (!ps) return { label: 'Not monitored', state: 'unknown' };
    const reserve = `${units(ps.reserve)}/${units(ps.capacity)} U`;
    let label;
    if (ps.state === 'brownout') label = `Brownout · ${ps.mandatoryLabel.toLowerCase()} short ${ps.mandatoryShortfall.toFixed(2)} U/s · reserve empty`;
    else if (ps.state === 'limited') label = `Reserve empty · work slowed · ${rate(ps.balance)}`;
    else if (ps.state === 'full') label = `Reserve full ${units(ps.capacity)} U`;
    else label = `Reserve ${reserve} · ${rate(ps.reserveRate)}`;
    return { label, state: ps.state, word: POWER_WORD[ps.state] };
  }

  /**
   * Player-visible notices for a committed transaction (runtime `observed`, plus `prev` for
   * ticks). This is the only path from simulation to the narrative strip. Remote facts reach it
   * only through knowledge; local facts only when the character perceives them: their own
   * completed work, and power changes on the host they occupy (OB-01, OB-02).
   */
  function projectNotices(state, geography, observed, prev = null) {
    const out = [...roomNotices(state, observed)];
    const name = id => labelOf(state, geography, id).toLowerCase();
    for (const id of observed?.newlySeen ?? []) if (typeOf(geography, state, id)) out.push(`New contact: ${name(id)}.`);
    for (const ch of observed?.reportChanges ?? []) {
      if (ch.from === null) continue;
      if (ch.to === 'docked') out.push(ch.hostId ? `The ${name(ch.id)} has docked at ${titleCase(labelOf(state, geography, ch.hostId))}.` : `The ${name(ch.id)} has docked.`);
      else if (ch.to === 'holding') out.push(`The ${name(ch.id)} has stopped and is holding position.`);
      else if (ch.to === 'moving') out.push(`The ${name(ch.id)} is under way.`);
    }
    if (!prev || prev.actor.hostId !== state.actor.hostId) return out;
    for (const [runId, r] of Object.entries(prev.work?.runs ?? {})) {
      if (r.actorId !== PLAYER || has(state.work.runs, runId)) continue;
      const word = { collect: 'Collection', fabricate: 'Fabrication', assemble: 'Assembly' }[r.kind];
      out.push(`${word} complete: ${Object.entries(r.outputs).map(([id, q]) => `+${formatQty(content, id, q)} ${itemLabel(id)}`).join(', ')}.`);
    }
    // Machines aboard the character's host: finished orders and newly blocked machines (perceived locally).
    const host = state.actor.hostId;
    for (const [orderId, o] of Object.entries(prev.orders?.orders ?? {})) {
      if (has(state.orders.orders, orderId) || state.equipment.banks[o.bankId]?.hostId !== host) continue;
      const finished = Object.entries(prev.work.runs).filter(([id, r]) => r.orderId === orderId && !has(state.work.runs, id)).length;
      const made = o.completed + finished;
      out.push(`${bankLabel(content, state.equipment.banks[o.bankId])} finished its order: ${made} made${o.aborted ? `, ${o.aborted} aborted` : ''}.`);
    }
    for (const [bankId, b] of banksAt(state, host)) {
      if (!content.equipment[b.model].processes || !prev.equipment.banks[bankId]) continue;
      const before = machineStatus(prev, geography, content, bankId).status, now = machineStatus(state, geography, content, bankId);
      if (before !== now.status && (now.status === 'STARVED' || now.status === 'OFFLINE')) out.push(`${bankLabel(content, b)}: ${now.status === 'STARVED' ? 'starved' : 'offline'}. ${now.reason}`);
    }
    const before = powerStatus(prev, geography, content, prev.actor.hostId), after = powerStatus(state, geography, content, state.actor.hostId);
    if (before && after && before.state !== after.state) {
      if (after.state === 'brownout') out.push(`Brownout: ${after.mandatoryLabel.toLowerCase()} is short of power. Work that needs power is paused.`);
      else if (before.state === 'brownout') out.push(`Power restored: ${after.mandatoryLabel.toLowerCase()} is fully supplied.`);
      else if (after.state === 'limited') out.push('The reserve is empty. Powered work has slowed to what generation can supply.');
    }
    return out;
  }

  /** What a remembered room topic is, in words (content labels only). */
  function topicLabel(state, hostId, placeKey, topic) {
    const i = topic.indexOf(':'), kind = topic.slice(0, i), key = topic.slice(i + 1);
    if (kind === 'subject') return authoredSite(state, content, hostId)?.places?.[placeKey]?.subjects?.[key]?.label ?? null;
    if (kind === 'deposit') return authoredSite(state, content, hostId)?.deposits?.[key]?.label ?? itemLabel(key);
    const b = state.equipment.banks[key];
    return b ? bankLabel(content, b).toLowerCase() : null;
  }

  /** One clause for a changed or newly noticed topic on re-entry, or null. */
  function changeClause(state, hostId, placeKey, c) {
    const label = topicLabel(state, hostId, placeKey, c.topic);
    if (!label) return null;
    const kind = c.topic.slice(0, c.topic.indexOf(':'));
    if (!c.from) return kind === 'bank' ? `a ${label} has been installed` : kind === 'subject' ? `you notice the ${label}` : null;
    if (kind === 'subject') return `the ${label} is now ${c.to}`;
    if (kind === 'deposit') {
      const deposit = `the ${itemLabel(c.topic.slice(8))} deposit`;
      return c.to === 'depleted' ? `${deposit} is exhausted` : c.to === 'low' ? `${deposit} is running low` : null;
    }
    if (kind === 'machine') return `the ${label} is now ${c.to.replace('-', ' ')}`;
    const [fc, fs, fq] = c.from.split('/'), [tc, ts, tq] = c.to.split('/');
    if (fc === 'damaged' && tc === 'intact') return `the ${label} has been repaired`;
    if (fc === 'intact' && tc === 'damaged') return `the ${label} is damaged`;
    if (fs !== ts) return ts === 'operational' ? `the ${label} is working again` : `the ${label} has stopped working`;
    if (fq !== tq) return `the ${label} now has ${tq} unit${tq === '1' ? '' : 's'}`;
    return null;
  }

  /**
   * Room sentences (S-47): one on entering a room — a short look around on a first visit, or
   * what changed since it was last seen (silent when nothing did) — and one when a subject
   * becomes perceivable while the character is there. Derived from the transaction's knowledge
   * delta only, so nothing replays after reload.
   */
  function roomNotices(state, observed) {
    const out = [];
    const { baselineItems, arrivalClauses } = content.observation;
    const a = observed?.arrival;
    if (a) {
      const { hostId, placeKey } = parseRef(a.placeRef);
      const placeName = placeLabel(state, hostId, placeKey).toLowerCase();
      if (a.first) {
        const things = [...new Set(a.noticed.filter(t => !t.startsWith('machine:')).map(t => topicLabel(state, hostId, placeKey, t)).filter(Boolean))];
        const shown = things.slice(0, baselineItems);
        out.push(things.length ? `You look around the ${placeName}: ${shown.join(', ')}${things.length > shown.length ? ' and more' : ''}.` : `You look around the ${placeName}. Nothing stands out.`);
      } else {
        const clauses = [...a.noticed.filter(t => !t.startsWith('machine:')).map(t => ({ topic: t, from: null, to: null })), ...a.changed]
          .map(c => changeClause(state, hostId, placeKey, c)).filter(Boolean);
        if (clauses.length) {
          const shown = clauses.slice(0, arrivalClauses), rest = clauses.length - shown.length;
          const list = rest ? `${shown.join(', ')} and ${rest} other change${rest > 1 ? 's' : ''}` : shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0];
          out.push(`Since you were last here, ${list}.`);
        }
      }
    }
    if (observed?.newlyPerceived?.length) {
      const { hostId, placeId } = state.actor;
      const labels = observed.newlyPerceived.map(t => topicLabel(state, hostId, placeId, t)).filter(Boolean);
      if (labels.length) out.push(`You notice the ${labels.join(' and the ')}.`);
    }
    return out;
  }

  /**
   * Presentation cues for a committed transition (S-40): `battery` when the character's host
   * repairs its generating equipment, or first gains generating units beyond its starting ones.
   * Derived from prev → state only, so a reload never replays it.
   */
  function projectCues(prev, state) {
    if (!prev || prev.actor.hostId !== state.actor.hostId) return [];
    const host = state.actor.hostId;
    const generating = st => banksAt(st, host).filter(([, b]) => (content.equipment[b.model].provides?.generation ?? 0) > 0);
    const repaired = generating(state).some(([id, b]) => b.health === 1 && (prev.equipment.banks[id]?.health ?? 1) < 1);
    const units = st => generating(st).reduce((n, [, b]) => n + b.quantity, 0);
    const start = (authoredSite(state, content, host)?.equipment ?? []).filter(e => (content.equipment[e.model].provides?.generation ?? 0) > 0).reduce((n, e) => n + e.quantity, 0);
    const firstExtra = units(prev) === start && units(state) > start;
    return repaired || firstExtra ? ['battery'] : [];
  }

  function knowledgeText(state, id, type) {
    const f = facets(state, id);
    if (f.surveyed) return 'Surveyed';
    if (f.identified) return f.identified.source === 'prior-record' ? 'Identified · charted record' : 'Identified';
    if (type === 'megastructure') return 'Silhouette only';
    if (type === 'asteroid') return 'Not surveyed';
    return 'Seen · not identified';
  }

  /** A recipe's inputs as text. */
  const recipeInputs = r => r.inputs.map(slot => `${formatQty(content, slot.item ?? slot.anyOf[0], slot.qty)} ${(slot.item ? [slot.item] : slot.anyOf).map(itemLabel).join(' or ')}`).join(', ');

  /** Whether the character's place offers a workbench (a capability any recipe or research method uses). */
  function benchHere(state, geography) {
    const caps = capabilitiesAt(state, content, state.actor.hostId, state.actor.placeId);
    return Object.values(content.recipes).some(r => r.tool !== null && caps.has(r.tool)) ||
      Object.values(researchCatalog(content).methods).some(m => !m.retired && m.predicate && conditionHolds(state, geography, content, content.research.methods[m.id].conditions, 'requires'));
  }

  function projectContext(state, geography, displayId) {
    const id = resolve(displayId);
    if (!id || !displayable(state, geography).includes(id)) return null;
    const type = typeOf(geography, state, id);
    if (type === 'ship') return vesselContext(state, geography, id);
    const aboard = state.actor.hostId === id;
    const local = visibleNow(state, geography, content).has(id) && type !== 'megastructure';
    const label = labelOf(state, geography, id);
    const known = identified(state, id);
    const def = known ? (authoredSite(state, content, id) ?? content.world.megastructures[state.entities[id]?.authoredId]) : null;
    const actions = [];
    if (aboard) {
      const here = placeLabel(state, id, state.actor.placeId);
      actions.push({ id: 'look-around', label: `Look around · ${here}`, kind: 'scene' });
      actions.push({ id: 'open-systems', label: 'Systems', kind: 'workspace', workspace: { kind: 'facility-systems', title: `${titleCase(label)} — systems` } });
      const bench = benchHere(state, geography);
      actions.push({ id: 'open-workbench', label: 'Workbench', kind: 'workspace', workspace: { kind: 'workbench', title: `${titleCase(label)} — workbench` },
        ...(bench ? { enabled: true } : { enabled: false, reason: 'Go to a compartment with an operational workbench.', category: 'access' }) });
      if (leaseOf(state, PLAYER)) actions.push({ id: 'cancel-work', label: `Stop: ${workView(state).label.toLowerCase()}`, kind: 'command', enabled: true });
      actions.push(...machineOpeners(state, id));
      actions.push(...moveActions(state, geography));
    } else if (type === 'station' && known) {
      actions.push({ id: 'request-docking', label: 'Request docking', kind: 'command', enabled: false,
        reason: hasPermission(state, PLAYER, id, 'dock') ? 'You have no transport to reach it.' : 'You have no transport, and no docking authorization.' });
    }
    if (type === 'station') actions.push(...sendHereActions(state, geography, id));
    const claims = type === 'megastructure' ? megastructureClaims(state, id) : [];
    return {
      title: titleCase(label),
      kind: titleCase(TYPE_WORD[type]) + (known && type === 'station' ? ' · landmark' : ''),
      knowledge: knowledgeText(state, id, type) + (claims.length && !known ? ` · ${claims.length} clue${claims.length > 1 ? 's' : ''}` : ''),
      access: aboard ? `You are aboard · ${placeLabel(state, id, state.actor.placeId).toLowerCase()}` : local ? 'Observed locally · not docked' : 'Remote observation',
      description: def?.description ?? GENERIC_DESC[type],
      actions,
      ...(claims.length ? { claims } : {})
    };
  }

  /**
   * Known claims about a megastructure (S-56): the `reveals` of fragments the character holds,
   * each with where it came from. Derived, never stored; the structure's identity, label and
   * position are untouched (K-01, K-02).
   */
  function megastructureClaims(state, id) {
    const key = state.entities[id]?.authoredId ?? id;
    return Object.keys(state.knowledge.fragments).sort().filter(f => content.fragments[f]?.reveals?.megastructure === key)
      .map(f => ({ text: content.fragments[f].reveals.claim, source: fragmentSource(state, f) }));
  }

  /** Where a held fragment came from, in words: its title and, for an examined source, the object and room. */
  function fragmentSource(state, fragmentId) {
    const def = content.fragments[fragmentId], src = state.knowledge.fragments[fragmentId]?.source;
    const r = src ? parseRef(src) : null;
    const subject = r?.subjectKey ? authoredSite(state, content, r.hostId)?.places?.[r.placeKey]?.subjects?.[r.subjectKey] : null;
    return subject ? `${def.title} — the ${subject.label}, ${placeLabel(state, r.hostId, r.placeKey).toLowerCase()}` : def.title;
  }

  function projectHud(state, geography) {
    const host = state.actor.hostId;
    const t = Math.floor(state.meta.simulationTime);
    const hh = String(Math.floor(t / 3600)).padStart(2, '0'), mm = String(Math.floor(t / 60) % 60).padStart(2, '0'), ss = String(t % 60).padStart(2, '0');
    const power = powerLine(state, geography);
    const alerts = [];
    if (power.state === 'brownout') alerts.push('Brownout: life support is short of power.');
    return {
      host: identified(state, host) ? titleCase(labelOf(state, geography, host)) : 'Unknown host',
      place: placeLabel(state, host, state.actor.placeId),
      power,
      work: workView(state),
      alerts,
      time: `T+${hh}:${mm}:${ss}`,
      fixture: false
    };
  }

  /**
   * SceneView for a subject (Habitat05_04 §5.1): the interior of the compartment the character
   * occupies, from the physical perspective. Its description and actions come from what the
   * character remembers of the room (observed automatically on arrival, S-47) and perceives in
   * person (deposits and banks here), not from hidden truth. No remote feed sources exist yet.
   */
  function projectScene(state, geography, displayId, perspective = 'physical') {
    const id = resolve(displayId);
    if (!id || perspective !== 'physical' || state.actor.hostId !== id) return null;
    const placeKey = state.actor.placeId;
    const placeDef = authoredSite(state, content, id)?.places?.[placeKey];
    if (!placeDef) return null;
    const hostLabel = titleCase(labelOf(state, geography, id));
    const seen = state.knowledge.places[`${id}/${placeKey}`]?.observed ?? {};
    // Examined state is the character's own knowledge (the completion record).
    const observed = Object.keys(seen).filter(t => t.startsWith('subject:')).map(t => t.slice(8))
      .map(k => ({ key: k, def: placeDef.subjects[k], condition: seen[`subject:${k}`], examined: has(state.knowledge.evidence, `${id}/${placeKey}/${k}`) })).filter(o => o.def);
    const summary = observed.length ? `Here: ${observed.map(o => `${o.def.label} (${o.examined ? 'examined' : o.condition})`).join(', ')}.` : '';
    // Distinct tones let the player see at a glance what was examined, only reviewed, or can be studied (S-25).
    const actions = [];
    for (const o of observed) if (o.def.kind === 'evidence') actions.push({ id: `examine:${o.key}`, label: `${o.examined ? 'Review' : 'Examine'} ${o.def.label}`, enabled: true, tone: o.examined ? 'review' : 'examine' });
    actions.push(...studyActions(state, geography, banksAt(state, id, placeKey).map(([bankId]) => bankId)));
    actions.push(...placeActions(state, geography));
    const facilities = placeFacilitiesText(state);
    return {
      sceneId: 'place-interior', subjectId: displayId, perspective: 'physical', basis: 'current-location',
      status: 'aboard',
      title: `${hostLabel} — ${placeDef.label}`,
      description: `${placeDef.description} ${facilities ? `${facilities} ` : ''}${summary}`.trim(),
      telemetry: { pressure: { label: 'Pressure', value: null } },   // not simulated yet: shown as unavailable, never invented
      actions: filterActionsForPerspective(actions, 'physical'),
      installed: installedHere(state, geography),
      skin: { bayLabel: `${placeDef.label.toUpperCase()} // ${hostLabel.toUpperCase()}`, scene: placeDef.scene, seed: displayId }
    };
  }

  /**
   * Study actions (S-51) for machines here: one per study that is ready now. A study that is not
   * ready is not shown at all, so no undiscovered branch is hinted at (R-04). Ids carry only the
   * display bank id and the study id.
   */
  function studyActions(state, geography, bankIds) {
    const catalog = researchCatalog(content), ctx = ctxOf(geography), out = [];
    for (const bankId of bankIds) {
      const b = state.equipment.banks[bankId];
      for (const study of catalog.studyOrder) {
        if (study.model !== b.model || !studyPreview(state, ctx, { studyId: study.id, bankId }).ok) continue;
        out.push({ id: `study:${did(bankId)}:${study.id}`, label: `Study the ${bankLabel(content, b).toLowerCase()}: ${study.name.toLowerCase()}`, kind: 'command', enabled: true, tone: 'study' });
      }
    }
    return out;
  }

  /** What is installed in the character's compartment, with its slots and each unit's condition. */
  function installedHere(state, geography) {
    const { hostId, placeId } = state.actor;
    const slots = slotsAt(state, content, hostId, placeId);
    const ps = powerStatus(state, geography, content, hostId);
    const rows = banksAt(state, hostId, placeId).map(([bankId, b]) => {
      const m = content.equipment[b.model];
      let status, detail;
      if (m.processes) { const ms = machineStatus(state, geography, content, bankId); status = ms.status; detail = machineLine(ms); }
      // Passive equipment has no operating state (S-42); its condition is described instead.
      else if (!isOperational(b)) { status = null; detail = 'Not operational.'; }
      else if (b.health < 1) { status = null; detail = `Damaged · ${Math.round(b.health * 100)} % effective. ${provisionLine(m, b, ps)}`; }
      else { status = null; detail = provisionLine(m, b, ps); }
      return { id: did(bankId), label: `${m.label}${b.quantity > 1 ? ` ×${b.quantity}` : ''}`, status, detail,
        battery: (m.provides?.storage ?? 0) > 0, controls: m.processes ? { id: `open-machine:${did(bankId)}`, label: 'Controls' } : null };
    });
    return { slots: { used: slots.used, total: slots.total }, rows };
  }

  /** What a passive bank provides, in words (battery charge, generation). */
  function provisionLine(m, b, ps) {
    if ((m.provides?.storage ?? 0) > 0) return ps ? `Charge ${units(ps.reserve)} of ${units(ps.capacity)} U.` : 'Storing energy.';
    if ((m.provides?.generation ?? 0) > 0) return `Generating ${(m.provides.generation * b.quantity * b.health).toFixed(2)} U/s.`;
    return 'Operational.';
  }

  /** A machine's state as one line: its order and its reason. */
  function machineLine(ms) {
    const o = ms.order;
    const order = !o ? '' : o.mode === 'repeat' ? 'Repeat until stopped. ' : `Order ${o.completed + o.inFlight + o.aborted} of ${o.requested} started · ${o.completed} made${o.aborted ? ` · ${o.aborted} aborted` : ''}. `;
    return `${order}${ms.reason}`.trim();
  }

  /** Context openers for each machine aboard: the machine workspace is anchored to these (U-02). */
  function machineOpeners(state, hostId) {
    return banksAt(state, hostId).filter(([, b]) => content.equipment[b.model].processes).map(([bankId, b]) => {
      const label = bankLabel(content, b);
      return { id: `open-machine:${did(bankId)}`, label: `${label} controls`, kind: 'workspace', workspace: { kind: 'machine', bankId: did(bankId), title: `${label} — controls` } };
    });
  }

  // ---------------------------------------------------------------- workspaces

  function systemsWorkspace(state, geography) {
    const hostId = state.actor.hostId;
    const ps = powerStatus(state, geography, content, hostId);
    const subject = did(hostId), at = state.meta.simulationTime;
    const power = ps ? {
      status: ps.state, word: POWER_WORD[ps.state], line: powerLine(state, geography).label,
      generation: datum({ subjectId: subject, metric: 'generation', value: ps.generation, unit: 'U/s', status: 'observed', observedAt: at }),
      mandatory: datum({ subjectId: subject, metric: 'mandatory', value: ps.mandatoryDemand, unit: 'U/s', status: 'observed', observedAt: at }),
      mandatoryLabel: ps.mandatoryLabel,
      shortfall: datum({ subjectId: subject, metric: 'shortfall', value: ps.mandatoryShortfall, unit: 'U/s', status: 'observed', observedAt: at }),
      baseline: datum({ subjectId: subject, metric: 'baseline', value: ps.baselineServed, unit: 'U/s', status: 'observed', observedAt: at }),
      process: datum({ subjectId: subject, metric: 'process', value: ps.processAllocated, unit: 'U/s', status: 'observed', observedAt: at }),
      balance: datum({ subjectId: subject, metric: 'balance', value: ps.balance, unit: 'U/s', status: 'observed', observedAt: at }),
      reserveRate: datum({ subjectId: subject, metric: 'reserveRate', value: ps.reserveRate, unit: 'U/s', status: 'observed', observedAt: at }),
      curtailed: datum({ subjectId: subject, metric: 'curtailed', value: ps.curtailed, unit: 'U/s', status: 'observed', observedAt: at }),
      reserve: datum({ subjectId: subject, metric: 'reserve', value: ps.reserve, unit: 'U', status: 'observed', observedAt: at }),
      capacity: datum({ subjectId: subject, metric: 'capacity', value: ps.capacity, unit: 'U', status: 'observed', observedAt: at }),
      secondsToEmpty: ps.secondsToEmpty
    } : null;
    const banks = banksAt(state, hostId).map(([bankId, b]) => {
      const m = content.equipment[b.model];
      const ms = m.processes ? machineStatus(state, geography, content, bankId) : null;
      return {
        id: did(bankId), label: bankLabel(content, b), place: placeLabel(state, hostId, b.placeId), quantity: b.quantity,
        health: Math.round(b.health * 100), operational: isOperational(b), status: ms?.status ?? null,
        battery: (m.provides?.storage ?? 0) > 0,
        summary: ms ? `${ms.status} · ${machineLine(ms)}` : !isOperational(b) ? 'Not operational' : b.health < 1 ? `Damaged · ${Math.round(b.health * 100)} % effective` : 'Operational',
        controls: ms ? { id: `open-machine:${did(bankId)}`, label: 'Controls', kind: 'workspace', workspace: { kind: 'machine', bankId: did(bankId), title: `${bankLabel(content, b)} — controls` } } : null
      };
    });
    const site = authoredSite(state, content, hostId);
    const slots = Object.entries(site?.places ?? {}).filter(([, p]) => (p.slots ?? 0) > 0).map(([placeId, p]) => {
      const s = slotsAt(state, content, hostId, placeId);
      return { id: placeId, text: `${p.label}${p.exterior ? ' (exterior)' : ''} · slots ${s.used} of ${s.total} used` };
    });
    const ctx = ctxOf(geography);
    const assemble = Object.entries(content.recipes).filter(([, r]) => r.tool === null && conditionHolds(state, geography, content, r.unlock, 'unlock')).map(([recipeId, r]) => {
      const p = preflightWork(state, ctx, { kind: 'craft', recipeId });
      return { id: `craft:${recipeId}`, label: r.label, detail: `${recipeInputs(r)} → ${r.qty} ${itemLabel(r.output)} · ${r.duration} s · by hand`, kind: 'command', ...disabled(p) };
    });
    const s = storageStatus(state, content, hostId);
    const items = Object.entries(holdOf(state, hostId)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([itemId, qty]) => ({
      itemId, label: content.items[itemId].label, category: content.items[itemId].category, qty: formatQty(content, itemId, qty),
      discard: { id: `discard:${itemId}:${qty}`, label: 'Discard all', kind: 'command', confirm: `Discard ${formatQty(content, itemId, qty)} of ${itemLabel(itemId)}? This cannot be undone.` }
    }));
    const m3 = v => Number((v / 1_000_000).toFixed(3));
    return {
      kind: 'facility-systems',
      power,
      banks,
      slots,
      assemble,
      storage: { used: m3(s.used), capacity: m3(s.capacity), reserved: m3(s.reservedForWork), overloaded: s.overloaded,
        committed: s.committedInputs.map(c => m3(c.volume)).reduce((a, b) => a + b, 0),
        summary: `${m3(s.used)} of ${m3(s.capacity)} m³ used${s.reservedForWork ? ` · ${m3(s.reservedForWork)} m³ reserved for work in progress` : ''}${s.overloaded ? ' · overloaded: only removals are possible' : ''}.`,
        items },
      work: workView(state)
    };
  }

  /** Recent experiment results, newest first. Equivalent consecutive attempts are grouped, but an attempt that made a discovery is never collapsed (D-4). */
  function recentResults(state) {
    const catalog = researchCatalog(content);
    const groups = [];
    for (const a of state.research.attempts) {
      const key = `${a.methodId}|${[...a.inputs].sort().join('+')}`;
      const last = groups.at(-1);
      if (last && last.key === key && !last.attempt.discoveries.length && !a.discoveries.length) { last.attempt = a; last.count += 1; }
      else groups.push({ key, attempt: a, count: 1 });
    }
    return groups.reverse().map(({ attempt: a, count }) => ({
      id: `attempt-${a.id}`,
      title: `${catalog.methods[a.methodId].name}: ${a.inputs.map(id => content.items[id].label).join(' + ')}${count > 1 ? ` (×${count})` : ''}`,
      observations: [...a.observations],
      outcome: a.discoveries.length ? `Discovered: ${a.discoveries.map(id => catalog.discoveries[id].name).join(', ')}` : 'Progress made toward a discovery.'
    }));
  }

  function workbenchWorkspace(state, geography) {
    const catalog = researchCatalog(content);
    const ctx = ctxOf(geography);
    const hostId = state.actor.hostId;
    const methods = Object.values(catalog.methods).filter(m => !m.retired).map(m => {
      const useful = [...usefulSamples(state, ctx, m.id)].sort();
      return { id: m.id, name: m.name, minSamples: m.minSamples, maxSamples: m.maxSamples,
        samples: useful.map(itemId => ({ itemId, label: content.items[itemId].label, held: formatQty(content, itemId, heldQty(state, hostId, itemId)), sample: formatQty(content, itemId, sampleCost(content, itemId)) })) };
    });
    const recipes = Object.entries(content.recipes).filter(([, r]) => r.tool !== null && conditionHolds(state, geography, content, r.unlock, 'unlock')).map(([recipeId, r]) => {
      const p = preflightWork(state, ctx, { kind: 'craft', recipeId });
      return { id: `craft:${recipeId}`, label: r.label, detail: `${recipeInputs(r)} → ${r.qty} ${itemLabel(r.output)} · ${r.duration} s`, kind: 'command', ...disabled(p) };
    });
    const discoveries = Object.entries(state.research.discoveries).sort(([a], [b]) => (a < b ? -1 : 1)).map(([id]) => {
      const d = catalog.discoveries[id];
      return { id: `discovery-${id}`, name: d.name, description: d.description, families: d.families.map(f => catalog.families[f].name) };
    });
    return { kind: 'workbench', methods, recipes, results: recentResults(state), attemptCount: state.research.attemptCount, discoveries, work: workView(state) };
  }

  /**
   * A machine's controls (S-37): its operating state, units and standby draw, processes known to
   * the character, its order (Make N / Repeat until stopped), batches in progress, abort with a
   * review of the loss (I-10; bound to the batches shown) and enable/disable. Controls need
   * presence in the machine's room; elsewhere aboard they are shown disabled with the reason.
   */
  function machineWorkspace(state, geography, bankId) {
    const b = state.equipment.banks[bankId];
    if (!b || b.hostId !== state.actor.hostId || !content.equipment[b.model].processes) return null;
    const m = content.equipment[b.model], ctx = ctxOf(geography), d = did(bankId);
    const ms = machineStatus(state, geography, content, bankId);
    const known = Object.entries(m.processes).filter(([, p]) => conditionHolds(state, geography, content, p.unlock, 'unlock'));
    const processes = known.map(([processId, p]) => {
      const io = p.kind === 'extract' ? `${formatQty(content, p.deposit, p.amount)} ${itemLabel(p.deposit)} from the deposit here`
        : `${Object.entries(p.inputs).map(([id, q]) => `${formatQty(content, id, q)} ${itemLabel(id)}`).join(', ')} → ${Object.entries(p.outputs).map(([id, q]) => `${formatQty(content, id, q)} ${itemLabel(id)}`).join(', ')}`;
      const gate = orderPreflight(state, ctx, { bankId, processId, mode: 'repeat' });
      return { id: processId, label: p.label, detail: `${io} · ${p.duration} s · ${p.powerRate} U/s`, enabled: gate.ok, reason: gate.ok ? '' : gate.reason };
    });
    const o = ms.order;
    const runs = ms.runs.map(r => ({ id: did(r.runId), label: `${m.processes[r.processId].label}${r.ordered ? '' : ' (finishing; no order)'}`, fraction: r.fraction,
      secondsLeft: r.secondsLeft, paused: r.speed === 0, slowed: r.speed > 0 && r.speed < 1 }));
    const runIds = ms.runs.map(r => r.runId);
    const ab = abortPreflight(state, ctx, { bankId, reviewed: runIds });
    const lost = {};
    for (const r of ms.runs) for (const [id, q] of Object.entries(r.inputs)) lost[id] = (lost[id] ?? 0) + q;
    const lostText = Object.entries(lost).map(([id, q]) => `${formatQty(content, id, q)} ${itemLabel(id)}`).join(', ');
    const after = !o ? '' : ' The order will be stopped and its remaining batches will not start.';
    const abort = { id: `abort:${d}:${runIds.map(did).join(',')}`, label: 'Abort order and all batches…', kind: 'command',
      confirm: `Abort ${runIds.length} batch${runIds.length === 1 ? '' : 'es'} on the ${m.label.toLowerCase()}? ${lostText ? `The committed inputs are lost: ${lostText}.` : 'Nothing has been consumed; the deposit claim is released.'}${after}`,
      ...disabled(ab) };
    const stop = { id: `stop-order:${d}`, label: 'Stop order (running batches finish)', kind: 'command', ...disabled(stopPreflight(state, ctx, { bankId })) };
    const orderText = !o ? 'No order. Choose a process and how many batches to make.'
      : o.mode === 'repeat' ? `Repeating ${m.processes[o.processId].label.toLowerCase()} until stopped · ${o.completed} made${o.aborted ? ` · ${o.aborted} aborted` : ''}.`
      : `Making ${o.requested} × ${m.processes[o.processId].label.toLowerCase()} · ${o.completed} made · ${o.inFlight} running${o.aborted ? ` · ${o.aborted} aborted` : ''} · ${Math.max(0, o.requested - o.completed - o.aborted - o.inFlight)} to start.`;
    return {
      kind: 'machine', id: d, label: m.label, place: placeLabel(state, b.hostId, b.placeId),
      status: ms.status, reason: ms.reason,
      units: `${ms.unitsOnline} of ${ms.units} unit${ms.units === 1 ? '' : 's'} online · standby ${(ms.baseline * ms.unitsOnline).toFixed(2)} U/s`,
      processes, orderText, orderAction: `order:${d}`, hasOrder: !!o, maxCount: MAX_ORDER_COUNT, runs, stop, abort, made: o ? o.completed : null, enabled: b.enabled,
      studies: studyActions(state, geography, [bankId])
    };
  }

  // ---------------------------------------------------------------- journal (R-05, PF-26, S-53)

  /** The familiarity word for a family's exposure (S-53). */
  const exposureWord = (c, v) => c.journal.exposureWords.find(w => v < w.below)?.word ?? c.journal.exposureWords.at(-1).word;
  const at = t => { const s = Math.floor(t); return `T+${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  const entry = (id, title, lines) => ({ id, title, lines, search: [title, ...lines].join(' ').toLowerCase() });

  /** Item-knowledge lines from learned facts only (S-52). */
  function itemLines(state, c, itemId, e) {
    const item = c.items[itemId], lines = [`${sentence(item.category)}.`];
    const group = (prefix, f) => e.facts.filter(x => x.startsWith(prefix)).map(x => f(x.slice(prefix.length))).filter(Boolean);
    const made = group('madeBy:', rid => c.recipes[rid]?.label);
    const used = group('usedIn:', rid => c.recipes[rid] ? c.items[c.recipes[rid].output].label : null);
    const proc = key => { const [model, pid] = key.split('/'); const m = c.equipment[model]; return m?.processes?.[pid] ? `${m.processes[pid].label} (${m.label.toLowerCase()})` : null; };
    const machines = [...new Set([...group('processIn:', proc), ...group('processOut:', proc)])];
    const sources = group('source:', key => {
      const r = parseRef(key);
      if (!r) return null;
      const word = state.knowledge.places[key]?.observed?.[`deposit:${itemId}`];
      return `${placeLabel(state, r.hostId, r.placeKey)}, ${titleCase(authoredSite(state, c, r.hostId)?.label ?? 'unknown')}${word ? ` · ${word} when last seen` : ''}`;
    });
    if (made.length) lines.push(`Made by: ${made.join('; ')}.`);
    if (used.length) lines.push(`Used in: ${[...new Set(used)].join(', ')}.`);
    if (machines.length) lines.push(`Machines: ${machines.join('; ')}.`);
    if (sources.length) lines.push(`Found at: ${sources.join('; ')}.`);
    if (item.installs) lines.push(`Installs as: ${c.equipment[item.installs].label.toLowerCase()}.`);
    for (const noteKey of group('note:', k => k)) { const n = item.notes?.[noteKey]; if (n) lines.push(`${n.title}: ${n.text}`); }
    return lines;
  }

  /**
   * The journal (a global utility, R-05): discoveries, clues, experiments, items and studies.
   * Pure; `c` is this observer's own content (one source of truth). It shows only what the
   * character has learned: no undiscovered discovery, item or branch appears (R-04, RS-11).
   */
  function projectJournal(state, geography, c = content) {
    const catalog = researchCatalog(c);
    const r = state.research;
    const discoveries = Object.entries(r.discoveries).sort(([a, x], [b, y]) => x.at - y.at || (a < b ? -1 : 1)).map(([id, rec]) => {
      const d = catalog.discoveries[id];
      const how = rec.via === 'experiment' ? 'experiment' : rec.via === 'study' ? 'engineering study' : 'other means';
      return entry(`discovery-${id}`, d.name, [d.description, `Learned by ${how} at ${at(rec.at)}.`,
        `Families: ${d.families.map(f => `${catalog.families[f].name} (${exposureWord(c, r.exposure[f] ?? 0)})`).join(', ')}.`]);
    });
    const clues = Object.entries(state.knowledge.fragments).sort(([a, x], [b, y]) => x.at - y.at || (a < b ? -1 : 1))
      .map(([id, rec]) => entry(`clue-${id}`, c.fragments[id].title, [c.fragments[id].text, `Source: ${fragmentSource(state, id)} · ${at(rec.at)}.`]));
    const experiments = recentResults(state).map(x => entry(x.id, x.title, [...x.observations, `${x.outcome}.`]));
    const items = Object.entries(state.knowledge.items).sort(([a], [b]) => (c.items[a].label < c.items[b].label ? -1 : 1))
      .map(([itemId, e]) => entry(`item-${itemId}`, c.items[itemId].label, itemLines(state, c, itemId, e)));
    const studies = Object.entries(r.studies).sort(([, x], [, y]) => x.at - y.at).map(([sid, s]) => {
      const study = catalog.studies[sid];
      return entry(`study-${sid}`, study.name, [`Studied the ${c.equipment[s.model].label.toLowerCase()} in the ${placeLabel(state, s.hostId, s.placeId).toLowerCase()} at ${at(s.at)}.`,
        `Result: ${catalog.discoveries[study.discovery].name}.`]);
    });
    const section = (id, title, entries, empty) => ({ id, title, entries, empty });
    return {
      kind: 'journal',
      sections: [
        section('discoveries', 'Discoveries', discoveries, 'No discoveries yet.'),
        section('clues', 'Clues', clues, 'No clues recorded yet.'),
        section('experiments', 'Experiments', experiments, `No experiments recorded yet.`),
        section('items', 'Items', items, 'No items recorded yet.'),
        section('studies', 'Studies', studies, 'No engineering studies yet.')
      ],
      attemptCount: r.attemptCount
    };
  }

  /** One trend sample of the character's host (A-03): reserve and capacity from powerStatus, or null. */
  function projectPowerSample(state, geography) {
    const hostId = state.actor.hostId;
    const ps = powerStatus(state, geography, content, hostId);
    if (!ps) return null;
    const subject = did(hostId), now = state.meta.simulationTime;
    return { subjectId: subject, at: now, state: ps.state,
      reserve: datum({ subjectId: subject, metric: 'reserve', value: ps.reserve, unit: 'U', status: 'observed', observedAt: now }),
      capacity: datum({ subjectId: subject, metric: 'capacity', value: ps.capacity, unit: 'U', status: 'observed', observedAt: now }) };
  }

  /** The open workspace's content for the character's current state, or null if it is unavailable. */
  function projectWorkspace(state, geography, ws) {
    // The journal is a global utility: it reads the character's own knowledge, anywhere.
    if (ws?.kind === 'journal') return projectJournal(state, geography);
    if (!ws || state.actor.hostId !== resolve(ws.hostId)) return null;
    if (ws.kind === 'facility-systems') return systemsWorkspace(state, geography);
    if (ws.kind === 'machine') return machineWorkspace(state, geography, resolve(ws.bankId));
    if (ws.kind === 'workbench') return benchHere(state, geography) ? workbenchWorkspace(state, geography) : null;
    return null;
  }

  /**
   * Preview of an experiment setup for the workbench (pure; never draws). Only held items can
   * be named, and reasons never name undiscovered research.
   */
  function projectExperimentPreview(state, geography, { methodId, samples }) {
    const catalog = researchCatalog(content);
    const p = previewExperiment(state, ctxOf(geography), { methodId, samples });
    const cost = Object.entries(p.cost).map(([id, q]) => `${formatQty(content, id, q)} ${itemLabel(id)}`).join(', ');
    const tendencies = Object.entries(p.tendencies).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
      .map(([f, n]) => `${catalog.families[f].name} (${n >= 4 ? 'strong' : 'moderate'})`).join(' · ');
    return { ok: p.ok, reason: p.ok ? 'This setup can yield new evidence. Outcomes are recorded after the experiment is saved.' : p.reason, category: p.category ?? null,
      cost: cost ? `Consumes: ${cost}.` : 'Select samples to review the cost.', tendencies: tendencies ? `Sample tendencies: ${tendencies}` : '' };
  }

  /** Translate a UI request (display ids, action ids) into a canonical command. */
  function toCommand(state, { targetId, actionId }) {
    const id = resolve(targetId);
    if (!id || typeof actionId !== 'string') return { type: 'unavailable' };
    const placeId = state.actor.placeId;
    if (actionId.startsWith('examine:')) return { type: 'examine', targetId: id, placeId, subjectKey: actionId.slice(8) };
    if (actionId === 'cancel-journey') return { type: 'cancelJourney', vesselId: id };
    if (actionId === 'dock-vessel') return { type: 'dockVessel', vesselId: id };
    if (actionId === 'undock-vessel') return { type: 'undockVessel', vesselId: id };
    if (actionId.startsWith('send-vessel:')) {
      const vesselId = resolve(actionId.slice(12));
      return vesselId ? { type: 'departVessel', vesselId, targetHostId: id, dockOnArrival: true } : { type: 'unavailable' };
    }
    // Stage 4 actions apply to the character's own host only.
    if (id !== state.actor.hostId) return { type: 'unavailable' };
    if (actionId.startsWith('move:')) return { type: 'moveToPlace', placeId: actionId.slice(5) };
    if (actionId.startsWith('collect:')) return { type: 'startCollection', itemId: actionId.slice(8) };
    if (actionId.startsWith('repair:')) { const bankId = resolve(actionId.slice(7)); return bankId ? { type: 'repairEquipment', bankId } : { type: 'unavailable' }; }
    if (actionId.startsWith('craft:')) return { type: 'startCraft', recipeId: actionId.slice(6) };
    if (actionId.startsWith('install:')) return { type: 'installItem', itemId: actionId.slice(8) };
    if (actionId.startsWith('order:')) {
      const [d, processId, mode, count] = actionId.slice(6).split(':');
      const bankId = resolve(d);
      return bankId ? { type: 'setOrder', bankId, processId, mode, ...(mode === 'count' ? { count: Number(count) } : {}) } : { type: 'unavailable' };
    }
    if (actionId.startsWith('study:')) {
      const [d, studyId] = actionId.slice(6).split(':');
      const bankId = resolve(d);
      return bankId && studyId ? { type: 'studyEquipment', studyId, bankId } : { type: 'unavailable' };
    }
    if (actionId.startsWith('stop-order:')) { const bankId = resolve(actionId.slice(11)); return bankId ? { type: 'stopOrder', bankId } : { type: 'unavailable' }; }
    if (actionId.startsWith('toggle:')) {
      const [d, on] = actionId.slice(7).split(':');
      const bankId = resolve(d);
      return bankId ? { type: 'setMachineEnabled', bankId, enabled: on === 'on' } : { type: 'unavailable' };
    }
    if (actionId.startsWith('abort:')) {
      const [d, list = ''] = actionId.slice(6).split(':');
      const bankId = resolve(d);
      const reviewed = list ? list.split(',').map(resolve) : [];
      return bankId && reviewed.every(Boolean) ? { type: 'abortMachineRuns', bankId, reviewed } : { type: 'unavailable' };
    }
    if (actionId === 'cancel-work') { const lease = leaseOf(state, PLAYER); return lease ? { type: 'cancelWork', runId: lease.runId } : { type: 'unavailable' }; }
    if (actionId.startsWith('experiment:')) {
      const [methodId, list = ''] = actionId.slice(11).split(':');
      return { type: 'runExperiment', methodId, samples: list ? list.split(',') : [] };
    }
    if (actionId.startsWith('discard:')) {
      const [itemId, qty, confirmed] = actionId.slice(8).split(':');
      return { type: 'discardCargo', itemId, qty: Number(qty), confirmed: confirmed === 'confirmed' };
    }
    return { type: 'unavailable' };
  }

  return { projectMap, projectContext, projectHud, projectScene, projectNotices, projectCues, projectWorkspace, projectExperimentPreview, projectJournal, projectPowerSample, toCommand, resolve };
}
