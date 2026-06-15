/**
 * Unit tests for pure functions (no network required).
 * Run: node tests/unit.test.js
 */

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}

// ── Import pure functions from API modules ──
// We require the modules' source files and extract testable logic

// --- redis.js: safeKey ---
const { safeKey, safeCompare } = require('../api/_lib/redis');

console.log('\n── safeKey ──');
assert(safeKey('hello world') === 'helloworld', 'strips spaces');
assert(safeKey('abc\x00def') === 'abcdef', 'strips control chars');
assert(safeKey('a'.repeat(100)) === 'a'.repeat(50), 'caps at 50 by default');
assert(safeKey('test', 3) === 'tes', 'respects custom maxLen');
assert(safeKey(123) === '', 'returns empty for non-string');
assert(safeKey(null) === '', 'returns empty for null');
assert(safeKey('Привіт') === 'Привіт', 'allows unicode');

// --- redis.js: safeCompare ---
console.log('\n── safeCompare ──');
assert(safeCompare('abc', 'abc') === true, 'same strings return true');
assert(safeCompare('abc', 'def') === false, 'different strings return false');
assert(safeCompare('abc', 'ab') === false, 'different lengths return false');
assert(safeCompare(null, 'abc') === false, 'null input returns false');
assert(safeCompare('abc', undefined) === false, 'undefined input returns false');
assert(safeCompare('', '') === true, 'empty strings return true');

// --- redis.js: parseRedisHash ---
const { parseRedisHash } = require('../api/_lib/redis');

console.log('\n── parseRedisHash ──');
assert(JSON.stringify(parseRedisHash(['a', '1', 'b', '2'])) === '{"a":"1","b":"2"}', 'array format');
assert(JSON.stringify(parseRedisHash({ x: 'y' })) === '{"x":"y"}', 'object passthrough');
assert(JSON.stringify(parseRedisHash(null)) === '{}', 'null returns empty');
assert(JSON.stringify(parseRedisHash(undefined)) === '{}', 'undefined returns empty');

// --- config.js: getUserRole ---
const { getUserRole } = require('../api/_lib/config');

console.log('\n── getUserRole ──');
assert(getUserRole('randomuser', {}) === 'user', 'unknown user returns user');
assert(getUserRole('randomuser', { role: 'starosta' }) === 'starosta', 'respects stored starosta role');
assert(getUserRole('randomuser', { role: 'teacher' }) === 'teacher', 'respects stored teacher role');

// --- homework.js helper: normalizeGroup (extract inline) ---
// Since normalizeGroup is not exported, we test it inline:
function normalizeGroup(g) {
  if (!g) return '';
  return g.split('-').map(p => {
    if (/^\d{2}$/.test(p) && parseInt(p) >= 20) return (parseInt(p) < 50 ? '20' : '19') + p;
    return p;
  }).join('-');
}
function sameGroup(a, b) { return normalizeGroup(a) === normalizeGroup(b); }

console.log('\n── normalizeGroup ──');
assert(normalizeGroup('КСМ-24-1') === 'КСМ-2024-1', 'expands 2-digit year 20+');
assert(normalizeGroup('КСМ-2024-1') === 'КСМ-2024-1', '4-digit year unchanged');
assert(normalizeGroup('КСМ-19-1') === 'КСМ-19-1', 'year <20 not expanded (not a year)');
assert(normalizeGroup('') === '', 'empty string');
assert(normalizeGroup(null) === '', 'null');
assert(sameGroup('КСМ-24-1', 'КСМ-2024-1'), 'sameGroup matches normalized');
assert(!sameGroup('КСМ-24-1', 'КСМ-24-2'), 'sameGroup rejects different');

// --- pidveska.js helper: sanitizeEntry (replicate inline) ---
const DATE_RE = /^\d{2}\.\d{2}(\.\d{4})?$/;
function sanitizeEntry(e) {
  if (!e || typeof e !== 'object') return null;
  let date = typeof e.date === 'string' ? e.date.trim() : '';
  if (!DATE_RE.test(date)) return null;
  const parts = date.split('.');
  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  date = `${parts[0]}.${parts[1]}`;
  const number = Number(e.number);
  if (!Number.isFinite(number) || number < 1 || number > 8) return null;
  const subject = typeof e.subject === 'string' ? e.subject.trim().slice(0, 200) : '';
  const teacher = typeof e.teacher === 'string' ? e.teacher.trim().slice(0, 100) : '';
  return { date, number, subject, teacher };
}

console.log('\n── sanitizeEntry ──');
assert(sanitizeEntry({ date: '15.06', number: 3, subject: 'Математика', teacher: 'Петренко' }) !== null, 'valid entry');
assert(sanitizeEntry({ date: '15.06', number: 3, subject: 'Математика', teacher: 'Петренко' }).date === '15.06', 'preserves date');
assert(sanitizeEntry({ date: '15.06.2025', number: 1, subject: 'Test' }).date === '15.06', 'strips year from date');
assert(sanitizeEntry({ date: '32.06', number: 1 }) === null, 'rejects day >31');
assert(sanitizeEntry({ date: '15.13', number: 1 }) === null, 'rejects month >12');
assert(sanitizeEntry({ date: '15.06', number: 0 }) === null, 'rejects number <1');
assert(sanitizeEntry({ date: '15.06', number: 9 }) === null, 'rejects number >8');
assert(sanitizeEntry(null) === null, 'rejects null');
assert(sanitizeEntry({}) === null, 'rejects empty object');
assert(sanitizeEntry({ date: 'invalid', number: 1 }) === null, 'rejects invalid date format');

// ── Results ──
console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
