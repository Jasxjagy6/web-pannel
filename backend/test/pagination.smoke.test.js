/* eslint-disable no-console */
/**
 * Smoke tests for utils/pagination — locks in:
 *   - default 100-row cap for normal callers
 *   - opt-in `allowUnbounded` mode (used only by the Sessions list)
 *     correctly returns MAX_UNBOUNDED_LIST when limit=0 / 'all' / -1
 *   - buildPagination returns an unbounded marker when allowed
 */

const path = require('path');
const {
  applyPagination,
  buildPagination,
  MAX_UNBOUNDED_LIST,
} = require(path.join(__dirname, '..', 'src', 'utils', 'pagination'));

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) { console.log(name, 'OK'); pass++; }
  else { console.error(name, 'FAIL', detail || ''); fail++; }
}

function defaultCapHonoured() {
  const a = applyPagination(null, 1, 250);
  ok('defaultCapHonoured.limit', a.limit === 100, JSON.stringify(a));
  ok('defaultCapHonoured.unbounded',
    a.unbounded === undefined, JSON.stringify(a));
}

function unboundedNotAllowedByDefault() {
  // limit=0 without allowUnbounded must NOT escape the cap. We coerce to
  // the default 20 (matches legacy behaviour pre-this-change).
  const a = applyPagination(null, 1, 0);
  ok('unboundedNotAllowedByDefault.cap',
    a.limit === 20, JSON.stringify(a));
  ok('unboundedNotAllowedByDefault.unbounded',
    a.unbounded === undefined, JSON.stringify(a));
}

function unboundedAllowedExplicitly() {
  const a = applyPagination(null, 1, 0, { allowUnbounded: true });
  ok('unboundedAllowedExplicitly.zero',
    a.limit === MAX_UNBOUNDED_LIST && a.unbounded === true,
    JSON.stringify(a));

  const b = applyPagination(null, 1, 'all', { allowUnbounded: true });
  ok('unboundedAllowedExplicitly.all',
    b.limit === MAX_UNBOUNDED_LIST && b.unbounded === true,
    JSON.stringify(b));

  const c = applyPagination(null, 1, -1, { allowUnbounded: true });
  ok('unboundedAllowedExplicitly.negative',
    c.limit === MAX_UNBOUNDED_LIST && c.unbounded === true,
    JSON.stringify(c));
}

function buildPaginationMarksUnbounded() {
  const p = buildPagination(1, 0, 1234, { allowUnbounded: true });
  ok('buildPaginationMarksUnbounded.unbounded',
    p.unbounded === true, JSON.stringify(p));
  ok('buildPaginationMarksUnbounded.totalPages',
    p.totalPages === 1, JSON.stringify(p));
  ok('buildPaginationMarksUnbounded.pageSize',
    p.pageSize === 1234, JSON.stringify(p));

  const q = buildPagination(1, 0, 0, { allowUnbounded: true });
  ok('buildPaginationMarksUnbounded.zero',
    q.totalPages === 1 && q.pageSize === 0, JSON.stringify(q));
}

function buildPaginationStandardPath() {
  const p = buildPagination(2, 25, 100);
  ok('buildPaginationStandardPath.totalPages',
    p.totalPages === 4, JSON.stringify(p));
  ok('buildPaginationStandardPath.hasNext',
    p.hasNext === true, JSON.stringify(p));
  ok('buildPaginationStandardPath.hasPrev',
    p.hasPrev === true, JSON.stringify(p));
}

defaultCapHonoured();
unboundedNotAllowedByDefault();
unboundedAllowedExplicitly();
buildPaginationMarksUnbounded();
buildPaginationStandardPath();

console.log(`\npagination.smoke.test: ${pass} pass / ${fail} fail`);
if (fail > 0) process.exit(1);
