// Small shared helpers for state shapes. No state ownership lives here.

export const SAFE_ID = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

export const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isSafeId = v => typeof v === 'string' && SAFE_ID.test(v) && !FORBIDDEN.has(v);
export const isFiniteNum = v => typeof v === 'number' && Number.isFinite(v);
export const isVec3 = p => isObj(p) && isFiniteNum(p.x) && isFiniteNum(p.y) && isFiniteNum(p.z);
export const has = (o, k) => Object.hasOwn(o, k);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v)) deepFreeze(v[k]); }
  return v;
}

/** A rejected request with a player-facing reason and a blocker category (Doc 02 §13.5). */
export class CommandError extends Error {
  constructor(message, category = 'request') { super(message); this.name = 'CommandError'; this.category = category; }
}

/** An invariant violation found by validation. */
export class ValidationError extends Error {
  constructor(message) { super(message); this.name = 'ValidationError'; }
}

export function check(cond, message) { if (!cond) throw new ValidationError(message); }
