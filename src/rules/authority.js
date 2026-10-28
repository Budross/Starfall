// Authority (rev 3 §D): owner, controller and a small permission set. Knowing about,
// seeing or being able to reach something never implies authority over it (E-02).
// Pure queries; access changes are written by domain/entities.
import { check, isObj, isSafeId } from '../core/shape.js';

export const PERMISSIONS = Object.freeze(['enter', 'dock', 'useFacilities', 'manageEquipment', 'command', 'transferCargo']);
const LABEL = { enter: 'entry', dock: 'docking', useFacilities: 'facility', manageEquipment: 'equipment management', command: 'command', transferCargo: 'cargo transfer' };

/** '' when the actor holds `perm` on the target, otherwise a player-facing reason. */
export function permissionReason(state, actorId, targetId, perm) {
  if (!PERMISSIONS.includes(perm)) throw new Error(`unknown permission ${perm}`);
  const actor = state.entities[actorId];
  if (!actor || actor.kind !== 'principal' || actor.lifecycle !== 'active') return 'No one is able to act.';
  const target = state.entities[targetId];
  if (!target) return 'That object has no registered authority.';
  if (target.lifecycle !== 'active') return 'It is not operational.';
  // Operational permissions belong to the controller, which falls back to the owner.
  const controller = target.controller ?? target.owner;
  if (controller === actorId) return '';
  if (target.access.public.includes(perm)) return '';
  if ((target.access.grants[actorId] || []).includes(perm)) return '';
  return `You have no ${LABEL[perm]} authorization here.`;
}

export const hasPermission = (state, actorId, targetId, perm) => permissionReason(state, actorId, targetId, perm) === '';

export function validateAccess(access, principals) {
  check(isObj(access) && Object.keys(access).sort().join() === 'grants,public', 'access must be exactly {public, grants}');
  check(Array.isArray(access.public), 'access.public must be an array');
  const perms = list => list.every(p => PERMISSIONS.includes(p)) && new Set(list).size === list.length;
  check(perms(access.public), 'access.public has unknown or duplicate permissions');
  check(isObj(access.grants), 'access.grants must be an object');
  for (const [who, list] of Object.entries(access.grants)) {
    check(isSafeId(who) && principals.has(who), `access grant to unknown principal ${who}`);
    check(Array.isArray(list) && list.length && perms(list), `access grant for ${who} has invalid permissions`);
  }
}
