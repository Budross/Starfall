// Authored effects (rev 3 §D). Compiled once and frozen; every effect in a list is
// preflighted before any mutation, then each executes by calling its owning domain.
// Effects that need an owner which does not exist yet are rejected at compile time,
// so no interim store is ever created for them.
import { isObj, isSafeId, has } from '../core/shape.js';
import { PERMISSIONS } from './authority.js';
import { setFlag } from '../domain/flags.js';
import { grantFragment } from '../domain/knowledge.js';
import { grantAccess, setAuthority } from '../domain/entities.js';

// The owners exist from Stage 4, but no content uses these effects yet, so they stay
// unavailable until the first content that needs them (no speculative paths).
const UNAVAILABLE = Object.freeze({
  discover: 'is not available until content needs a generic discovery grant',
  grantItem: 'is not available until content needs an item grant'
});
const SUPPORTED = new Set(['setFlag', 'grantFragment', 'grantAccess', 'transferAuthority']);

export class EffectError extends Error { constructor(m) { super(m); this.name = 'EffectError'; } }

export function compileEffects(list) {
  if (!Array.isArray(list)) throw new EffectError('effects must be an array');
  return Object.freeze(list.map(e => {
    if (!isObj(e) || Object.keys(e).length !== 1) throw new EffectError('each effect must have exactly one key');
    const [op] = Object.keys(e);
    if (has(UNAVAILABLE, op)) throw new EffectError(`effect ${op} ${UNAVAILABLE[op]}`);
    if (!SUPPORTED.has(op)) throw new EffectError(`unknown effect ${op}`);
    return Object.freeze({ op, args: structuredClone(e[op]) });
  }));
}

const entityId = (ctx, key) => ctx.geography.anchors[key] ?? (key === 'player' ? 'player' : null);

/** Throws if any effect cannot apply to this state. Mutates nothing. */
export function preflightEffects(state, effects, ctx) {
  for (const { op, args } of effects) {
    if (op === 'setFlag' && !isSafeId(args)) throw new EffectError(`setFlag needs a flag name`);
    if (op === 'grantFragment' && !has(ctx.content.fragments, args)) throw new EffectError(`unknown fragment ${args}`);
    if (op === 'grantAccess') {
      const t = entityId(ctx, args?.target), p = entityId(ctx, args?.principal) ?? args?.principal;
      if (!t || !state.entities[t]) throw new EffectError('grantAccess target does not resolve');
      if (state.entities[p]?.kind !== 'principal') throw new EffectError('grantAccess principal does not resolve');
      if (!PERMISSIONS.includes(args.permission)) throw new EffectError(`unknown permission ${args.permission}`);
    }
    if (op === 'transferAuthority') {
      const t = entityId(ctx, args?.target);
      if (!t || !state.entities[t] || state.entities[t].kind === 'principal') throw new EffectError('transferAuthority target does not resolve');
      for (const role of ['owner', 'controller']) {
        if (args[role] === undefined || args[role] === null) continue;
        if (state.entities[entityId(ctx, args[role]) ?? args[role]]?.kind !== 'principal') throw new EffectError(`transferAuthority ${role} does not resolve`);
      }
    }
  }
}

/** Apply preflighted effects through their owners. */
export function applyEffects(candidate, effects, ctx) {
  for (const { op, args } of effects) {
    if (op === 'setFlag') setFlag(candidate, args);
    else if (op === 'grantFragment') grantFragment(candidate, args, ctx.sourceRef ?? null);
    else if (op === 'grantAccess') grantAccess(candidate, entityId(ctx, args.target), entityId(ctx, args.principal) ?? args.principal, args.permission);
    else if (op === 'transferAuthority') {
      const role = r => args[r] === undefined ? undefined : args[r] === null ? null : (entityId(ctx, args[r]) ?? args[r]);
      setAuthority(candidate, entityId(ctx, args.target), { owner: role('owner'), controller: role('controller') });
    }
  }
}
