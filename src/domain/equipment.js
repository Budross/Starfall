// Installed equipment. Sole writer of the `equipment` slice.
//
//   equipment{banks{bankId:{hostId, placeId, model, quantity, health, enabled}}}
//
// A bank is a group of identical units installed together at one place. It is operational
// when quantity > 0, enabled and health > 0; only operational banks provide capabilities.
// A host's capabilities are always derived from its installed banks by the authored
// aggregation rules (content.provisions) and never stored (the first-level composition
// contract): this module names no model, and the engine knows only the `sum` rule.
// Capability never implies authorization (E-02).
//
// Installation (S-36) needs both a free slot at the place (plain capacity, one per unit) and
// the place's eligibility for the model (authored placement). Install and repair are
// instant (S-32); enable/disable applies to toggleable machines only.
import { check, isObj, isSafeId, isFiniteNum, has, CommandError } from '../core/shape.js';
import { allocateId, requireSlice } from '../core/state.js';
import { authoredSite, siteOf, conditionHolds } from './world.js';
import { heldQty, withdraw, formatQty } from './inventory.js';
import { leaseOf } from './work.js';
import { append } from '../rules/ledger.js';
import { permissionReason } from '../rules/authority.js';

export const isOperational = b => b.quantity > 0 && b.enabled === true && b.health > 0;

export const banksAt = (state, hostId, placeId) =>
  Object.entries(state.equipment?.banks ?? {}).filter(([, b]) => b.hostId === hostId && (placeId === undefined || b.placeId === placeId));

/** Capabilities provided by operational banks at a host's place (set union). */
export function capabilitiesAt(state, content, hostId, placeId) {
  const out = new Set();
  for (const [, b] of banksAt(state, hostId, placeId)) if (isOperational(b)) for (const c of content.equipment[b.model].capabilities ?? []) out.add(c);
  return out;
}

/**
 * A numeric capability of a host, aggregated over its operational banks by the authored rule
 * for `key` (content.provisions): per-unit value × quantity, × health when the rule scales by
 * health, combined by `sum`. Derived, never stored.
 */
export function provisionAt(state, content, hostId, key) {
  const rule = content.provisions[key];
  check(rule && rule.combine === 'sum', `no aggregation rule for capability ${key}`);
  let total = 0;
  for (const [, b] of banksAt(state, hostId)) {
    if (!isOperational(b)) continue;
    const v = content.equipment[b.model].provides?.[key] ?? 0;
    total += v * b.quantity * (rule.scaleByHealth ? b.health : 1);
  }
  return total;
}

/** Generation in U/s of every operational bank at a host. */
export const generationAt = (state, content, hostId) => provisionAt(state, content, hostId, 'generation');

/** Storage capacity in U of every operational bank at a host. */
export const storageAt = (state, content, hostId) => provisionAt(state, content, hostId, 'storage');

/** Installation slots at a place: {total, used, free}. Used counts every installed unit. */
export function slotsAt(state, content, hostId, placeId) {
  const total = authoredSite(state, content, hostId)?.places?.[placeId]?.slots ?? 0;
  const used = banksAt(state, hostId, placeId).reduce((n, [, b]) => n + b.quantity, 0);
  return { total, used, free: total - used };
}

/**
 * Placement eligibility (S-36), separate from slot capacity: '' when an authored place may hold
 * the model, otherwise the reason. `site` is the authored site definition. Shared by content
 * validation, state validation and installation (one answer, PF-10).
 */
export function placementReason(content, site, placeId, modelId) {
  const m = content.equipment[modelId], place = site?.places?.[placeId];
  if (!m || !place) return 'that place does not exist';
  if ((m.placement?.exterior === true) !== (place.exterior === true)) return m.placement?.exterior ? 'it must be mounted outside the hull' : 'it must be installed inside the hull';
  if (m.placement?.deposit) {
    const worked = new Set(Object.values(m.processes ?? {}).filter(p => p.kind === 'extract').map(p => p.deposit));
    if (!Object.values(site.deposits ?? {}).some(d => d.placeKey === placeId && worked.has(d.itemId))) return 'it needs a deposit it can work in the same room';
  }
  return '';
}

const placeLabel = (state, content, hostId, placeId) => (authoredSite(state, content, hostId)?.places?.[placeId]?.label ?? 'compartment').toLowerCase();
const fail = (category, reason) => ({ ok: false, category, reason });

function handsFree(state, ctx) {
  const lease = leaseOf(state, ctx.actorId);
  return lease ? fail('timing', 'You are busy with other work. Finish or cancel it first.') : null;
}

// ---------------------------------------------------------------- installation

/**
 * Whether the character can install one held product here now, and where it would go. Pure;
 * shared by the observer's install actions and the command. Returns
 * {ok, category?, reason?, preview?:{modelId, placeId, mergeInto}}.
 */
export function installPreflight(state, ctx, { itemId }) {
  const { content } = ctx;
  const { hostId, placeId } = state.actor;
  const item = content.items[itemId];
  if (!item?.installs) return fail('request', 'That cannot be installed.');
  const modelId = item.installs, model = content.equipment[modelId];
  const busy = handsFree(state, ctx);
  if (busy) return busy;
  const denied = permissionReason(state, ctx.actorId, hostId, 'manageEquipment');
  if (denied) return fail('access', denied);
  if (heldQty(state, hostId, itemId) < 1) return fail('materials', `You have no ${item.label.toLowerCase()} here.`);
  const site = authoredSite(state, content, hostId);
  const where = placementReason(content, site, placeId, modelId);
  if (where) return fail('placement', `The ${model.label.toLowerCase()} cannot go in the ${placeLabel(state, content, hostId, placeId)}: ${where}.`);
  const slots = slotsAt(state, content, hostId, placeId);
  if (slots.free < 1) return fail('slots', `No free installation slot in the ${placeLabel(state, content, hostId, placeId)} (${slots.used} of ${slots.total} used).`);
  const merge = banksAt(state, hostId, placeId).find(([, b]) => b.model === modelId && b.health === 1 && b.enabled === true);
  return { ok: true, preview: { modelId, placeId, mergeInto: merge ? merge[0] : null } };
}

/** Install one held product at the character's place (instant). */
export function install(candidate, ctx, { itemId }) {
  const p = installPreflight(candidate, ctx, { itemId });
  if (!p.ok) throw new CommandError(p.reason, p.category);
  const { hostId } = candidate.actor;
  withdraw(candidate, hostId, { [itemId]: 1 });
  let bankId = p.preview.mergeInto;
  if (bankId) candidate.equipment.banks[bankId].quantity += 1;
  else {
    bankId = allocateId(candidate, 'bank');
    candidate.equipment.banks[bankId] = { hostId, placeId: p.preview.placeId, model: p.preview.modelId, quantity: 1, health: 1, enabled: true };
  }
  append(candidate, 'EQUIPMENT_INSTALLED', { bankId, model: p.preview.modelId });
  const label = ctx.content.equipment[p.preview.modelId].label;
  return { kind: 'EQUIPMENT_INSTALLED', message: `Installed the ${label.toLowerCase()} in the ${placeLabel(candidate, ctx.content, hostId, p.preview.placeId)}.`, changes: { banks: [bankId] } };
}

// ---------------------------------------------------------------- repair (instant, S-32)

/** Whether the character can repair this bank now. Pure; shared by the observer and the command. */
export function repairPreflight(state, ctx, { bankId }) {
  const { content } = ctx;
  const { hostId, placeId } = state.actor;
  const bank = state.equipment?.banks?.[bankId];
  if (!bank || bank.hostId !== hostId) return fail('request', 'There is nothing like that to repair here.');
  const def = repairDef(content, bank);
  if (!def || bank.health >= 1) return fail('request', `The ${bankLabel(content, bank).toLowerCase()} does not need repair.`);
  const busy = handsFree(state, ctx);
  if (busy) return busy;
  const denied = permissionReason(state, ctx.actorId, hostId, 'useFacilities');
  if (denied) return fail('access', denied);
  if (bank.placeId !== placeId) return fail('access', `You need to be in the ${placeLabel(state, content, hostId, bank.placeId)} to repair that.`);
  if (!conditionHolds(state, ctx.geography, content, def.unlock, 'unlock')) return fail('research', 'You do not yet understand how to repair this.');
  for (const [itemId, qty] of Object.entries(def.inputs)) {
    if (heldQty(state, hostId, itemId) < qty) return fail('materials', `Needs ${formatQty(content, itemId, qty)} ${content.items[itemId].label.toLowerCase()}${qty > 1 ? 's' : ''}.`);
  }
  return { ok: true, preview: { inputs: { ...def.inputs } } };
}

export function repair(candidate, ctx, { bankId }) {
  const p = repairPreflight(candidate, ctx, { bankId });
  if (!p.ok) throw new CommandError(p.reason, p.category);
  withdraw(candidate, candidate.actor.hostId, p.preview.inputs);
  const b = candidate.equipment.banks[bankId];
  b.health = 1;
  append(candidate, 'EQUIPMENT_REPAIRED', { bankId });
  return { kind: 'EQUIPMENT_REPAIRED', message: `Repaired the ${bankLabel(ctx.content, b).toLowerCase()}.`, changes: { banks: [bankId] } };
}

// ---------------------------------------------------------------- enable / disable

/** Whether the character can switch this machine on or off now (presence in its room, S-37). */
export function togglePreflight(state, ctx, { bankId, enabled }) {
  const { content } = ctx;
  const { hostId, placeId } = state.actor;
  const bank = state.equipment?.banks?.[bankId];
  if (!bank || bank.hostId !== hostId || !content.equipment[bank.model].toggleable) return fail('request', 'That cannot be switched on or off.');
  if (typeof enabled !== 'boolean' || bank.enabled === enabled) return fail('request', `The ${bankLabel(content, bank).toLowerCase()} is already ${bank.enabled ? 'enabled' : 'disabled'}.`);
  const denied = permissionReason(state, ctx.actorId, hostId, 'manageEquipment');
  if (denied) return fail('access', denied);
  if (bank.placeId !== placeId) return fail('access', `You need to be in the ${placeLabel(state, content, hostId, bank.placeId)} to control that.`);
  return { ok: true };
}

/** Enable or disable a machine. Disabling pauses its batches; nothing is lost. */
export function setEnabled(candidate, ctx, { bankId, enabled }) {
  const p = togglePreflight(candidate, ctx, { bankId, enabled });
  if (!p.ok) throw new CommandError(p.reason, p.category);
  const b = candidate.equipment.banks[bankId];
  b.enabled = enabled;
  append(candidate, 'EQUIPMENT_TOGGLED', { bankId, enabled });
  return { kind: 'EQUIPMENT_TOGGLED', message: `The ${bankLabel(ctx.content, b).toLowerCase()} is ${enabled ? 'enabled' : 'disabled'}.`, changes: { banks: [bankId] } };
}

// ---------------------------------------------------------------- creation (world creation only)

/** Create every authored site's starting banks. Each authored place must resolve in this world's frozen geography. */
export function initializeEquipment(candidate, { geography, content }) {
  check(!has(candidate, 'equipment'), 'equipment already exists');
  candidate.equipment = { banks: {} };
  for (const key of Object.keys(geography.anchors).sort()) {
    const id = geography.anchors[key], def = content.world.sites[key];
    if (!def?.equipment) continue;
    for (const e of def.equipment) {
      check(has(geography.sites[id]?.places ?? {}, e.placeId), `authored bank place ${key}/${e.placeId} does not exist in this world's geography`);
      const bankId = allocateId(candidate, 'bank');
      candidate.equipment.banks[bankId] = { hostId: id, placeId: e.placeId, model: e.model, quantity: e.quantity, health: e.health, enabled: true };
    }
  }
  requireSlice(candidate, 'equipment');
}

const BANK_KEYS = 'enabled,health,hostId,model,placeId,quantity';

export function validateEquipment(state, geography, content) {
  const eq = state.equipment;
  check(isObj(eq) && Object.keys(eq).join() === 'banks' && isObj(eq.banks), 'equipment must be exactly {banks}');
  const used = {};
  for (const [id, b] of Object.entries(eq.banks)) {
    check(isSafeId(id) && isObj(b) && Object.keys(b).sort().join() === BANK_KEYS, `bank ${id} fields invalid`);
    const host = siteOf(state, geography, b.hostId);
    check(host && has(host.places, b.placeId), `bank ${id} place does not resolve`);
    check(has(content.equipment, b.model), `bank ${id} has unknown model ${b.model}`);
    check(Number.isSafeInteger(b.quantity) && b.quantity >= 0, `bank ${id} quantity invalid`);
    check(isFiniteNum(b.health) && b.health >= 0 && b.health <= 1, `bank ${id} health must be 0..1`);
    check(typeof b.enabled === 'boolean', `bank ${id} enabled must be boolean`);
    check(b.enabled || content.equipment[b.model].toggleable === true, `bank ${id} cannot be disabled`);
    const site = authoredSite(state, content, b.hostId);
    if (site) {
      const why = placementReason(content, site, b.placeId, b.model);
      check(!why, `bank ${id} is not allowed at ${b.placeId}: ${why}`);
      const key = `${b.hostId}/${b.placeId}`;
      used[key] = (used[key] ?? 0) + b.quantity;
      check(used[key] <= (site.places[b.placeId]?.slots ?? 0), `place ${key} has more installed units than slots`);
    }
  }
}

/** Display label of a bank's model (content). */
export const bankLabel = (content, bank) => content.equipment[bank.model]?.label ?? 'equipment';

/** Authored repair definition for a bank's model, or null. */
export const repairDef = (content, bank) => content.equipment[bank.model]?.repair ?? null;

/** The host's authored facility power definition, or null. */
export const powerDef = (state, content, hostId) => authoredSite(state, content, hostId)?.power ?? null;
