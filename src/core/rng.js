// Deterministic randomness and hashing. World generation uses no stream state: every
// random decision is a pure function of (seed, ...keys). There is no saved random stream:
// research is deterministic (S-33 D-3).

/** 32-bit FNV-1a over a string, then a murmur-style finalizer. */
function hash32(str, h = 0x811c9dc5) {
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

/** A stable uint32 in [0, 2³²) for this seed and key path. */
export function keyedUint32(seed, ...keys) {
  return hash32(JSON.stringify(keys), (seed >>> 0) ^ 0x9e3779b9);
}

/** A stable value in [0, 1) for this seed and key path. */
export function keyed(seed, ...keys) {
  return keyedUint32(seed, ...keys) / 4294967296;
}

/** Cheap content hash (64 bits as 16 hex chars) used for geoHash. Not cryptographic. */
export function hashString(str) {
  const a = hash32(str, 0x811c9dc5), b = hash32(str, 0x01234567);
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** 128-bit random world identity. */
export function newWorldId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** A random uint32 seed for a new game. */
export function newSeed() {
  const v = new Uint32Array(1);
  crypto.getRandomValues(v);
  return v[0];
}
