// Condition language (rev 3 §D). One compiler produces a frozen AST that every consumer
// evaluates (PF-08). `unlock` conditions may use knowledge predicates only (C-01, PF-09);
// visibility = unlock, execution = unlock && requires.
import { isObj, isSafeId } from '../core/shape.js';

export const KNOWLEDGE_PREDICATES = Object.freeze(['discovery', 'flag', 'fragment', 'met']);
export const OPERATIONAL_PREDICATES = Object.freeze(['capability', 'atHost', 'atPlace', 'holds']);
const MAX_DEPTH = 16;

export class ConditionError extends Error { constructor(m) { super(m); this.name = 'ConditionError'; } }

/**
 * Compile a condition to a frozen AST.
 * @param cond   authored condition, e.g. {all: [{fragment: 'x'}, {not: {flag: 'y'}}]}
 * @param mode   'unlock' (knowledge predicates only) | 'requires' (any predicate)
 */
export function compile(cond, { mode = 'requires' } = {}) {
  if (mode !== 'unlock' && mode !== 'requires') throw new ConditionError(`unknown condition mode ${mode}`);
  return node(cond, mode, 0);
}

function node(c, mode, depth) {
  if (depth > MAX_DEPTH) throw new ConditionError(`condition deeper than ${MAX_DEPTH}`);
  if (!isObj(c)) throw new ConditionError('condition must be an object');
  const keys = Object.keys(c);
  if (keys.length !== 1) throw new ConditionError(`condition must have exactly one key, got [${keys.join(', ')}]`);
  const [k] = keys, v = c[k];
  if (k === 'all' || k === 'any') {
    if (!Array.isArray(v) || !v.length) throw new ConditionError(`${k} needs a non-empty array`);
    return Object.freeze({ op: k, args: Object.freeze(v.map(x => node(x, mode, depth + 1))) });
  }
  if (k === 'not') return Object.freeze({ op: 'not', arg: node(v, mode, depth + 1) });
  const knowledge = KNOWLEDGE_PREDICATES.includes(k), operational = OPERATIONAL_PREDICATES.includes(k);
  if (!knowledge && !operational) throw new ConditionError(`unknown predicate ${k}`);
  if (mode === 'unlock' && operational) throw new ConditionError(`unlock conditions may use knowledge predicates only; ${k} is operational`);
  if (k === 'holds') {
    if (!isObj(v) || !isSafeId(v.itemId) || !Number.isSafeInteger(v.qty) || v.qty <= 0) throw new ConditionError('holds needs {itemId, qty>0}');
    return Object.freeze({ op: 'pred', name: k, value: Object.freeze({ itemId: v.itemId, qty: v.qty }) });
  }
  if (!isSafeId(v)) throw new ConditionError(`${k} needs an id`);
  return Object.freeze({ op: 'pred', name: k, value: v });
}

/** Every predicate the AST references, in order. */
export function references(ast, out = []) {
  if (ast.op === 'pred') out.push({ predicate: ast.name, value: ast.value });
  else if (ast.op === 'not') references(ast.arg, out);
  else ast.args.forEach(a => references(a, out));
  return out;
}

/**
 * Evaluate against query functions {predicateName: value => boolean}. Every referenced
 * predicate must have a query even when short-circuiting would skip it.
 * Returns {ok: true} or {ok: false, reason: {predicate, value, negated}}.
 */
export function evaluate(ast, queries) {
  for (const r of references(ast)) {
    if (typeof queries[r.predicate] !== 'function') throw new ConditionError(`no query provided for predicate ${r.predicate}`);
  }
  return ev(ast, queries, false);
}

function ev(ast, q, negated) {
  if (ast.op === 'pred') {
    const truth = !!q[ast.name](ast.value);
    return truth !== negated ? { ok: true } : { ok: false, reason: { predicate: ast.name, value: ast.value, negated } };
  }
  if (ast.op === 'not') return ev(ast.arg, q, !negated);
  // De Morgan under negation: not(all) behaves as any(not), not(any) as all(not).
  const conjunctive = (ast.op === 'all') !== negated;
  let firstFailure = null;
  for (const a of ast.args) {
    const r = ev(a, q, negated);
    if (conjunctive && !r.ok) return r;
    if (!conjunctive && r.ok) return r;
    firstFailure ??= r;
  }
  return conjunctive ? { ok: true } : firstFailure;
}

/** The first blocking reason, or null when the condition holds. */
export function explain(ast, queries) {
  const r = evaluate(ast, queries);
  return r.ok ? null : r.reason;
}
