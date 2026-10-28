// Authored story flags. Sole writer of the `flags` slice. Values are `true` only:
// a flag is either set or absent.
import { check, isObj, isSafeId } from '../core/shape.js';

export function initialFlags() { return {}; }

export function setFlag(candidate, name) {
  check(isSafeId(name), `invalid flag name ${name}`);
  if (candidate.flags[name] === true) return false;
  candidate.flags[name] = true;
  return true;
}

export function validateFlags(flags) {
  check(isObj(flags), 'flags must be an object');
  for (const [k, v] of Object.entries(flags)) check(isSafeId(k) && v === true, `flag ${k} must be true`);
}
