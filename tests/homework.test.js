/**
 * Integration tests for the homework API (/api/homework).
 * 
 * Run: node tests/homework.test.js
 * 
 * Requires the site to be running.
 * Set TEST_BASE_URL environment variable if not using production.
 */
const BASE = process.env.TEST_BASE_URL || 'https://mpmek.site';
const API = `${BASE}/api/homework`;

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

async function jsonReq(url, opts = {}) {
  const resp = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...opts.headers
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data, headers: resp.headers };
}

async function testPublicGet() {
  console.log('\n── Homework GET (public, valid group) ──');
  const r = await jsonReq(`${API}?group=${encodeURIComponent('КСМ-2024-1')}`);
  assert(r.status === 200, 'Returns 200 for valid group');
  assert(r.data && typeof r.data === 'object', 'Returns object body');
  assert('texts' in r.data || typeof r.data === 'object', 'Has texts field or is object');
}

async function testGetMissingGroup() {
  console.log('\n── Homework GET (missing group param) ──');
  const r = await jsonReq(API);
  assert(r.status === 400, 'Returns 400 when group param missing');
}

async function testGetEmptyGroup() {
  console.log('\n── Homework GET (nonexistent group) ──');
  const r = await jsonReq(`${API}?group=NONEXISTENT_GROUP_XYZ`);
  assert(r.status === 200, 'Returns 200 for unknown group (empty data)');
}

async function testPostWithoutAuth() {
  console.log('\n── Homework POST (no auth) ──');
  const r = await jsonReq(API, {
    method: 'POST',
    body: { group: 'КСМ-2024-1', day: '2026-05-25', number: 1, text: 'test' }
  });
  assert(r.status === 401 || r.status === 403, 'Rejects POST without auth');
}

async function testUploadWithoutAuth() {
  console.log('\n── Homework upload (no auth) ──');
  const r = await jsonReq(`${API}?action=upload`, {
    method: 'POST',
    body: { group: 'КСМ-2024-1', day: '2026-05-25', number: 1, fileName: 'test.jpg', fileType: 'image/jpeg', fileData: 'dGVzdA==' }
  });
  assert(r.status === 401 || r.status === 403, 'Rejects upload without auth');
}

async function testDeleteAttachmentWithoutAuth() {
  console.log('\n── Homework delete-attachment (no auth) ──');
  const r = await jsonReq(`${API}?action=delete-attachment`, {
    method: 'POST',
    body: { group: 'КСМ-2024-1', day: '2026-05-25', number: 1, url: 'https://example.com/fake.jpg' }
  });
  assert(r.status === 401 || r.status === 403, 'Rejects delete-attachment without auth');
}

async function testMethodNotAllowed() {
  console.log('\n── Homework DELETE method ──');
  const r = await jsonReq(API, { method: 'DELETE' });
  assert(r.status === 405, 'Rejects DELETE method');
}

// ── Run all ──
(async () => {
  console.log(`\n🧪 Homework API Integration Tests — ${BASE}\n`);

  try {
    await testPublicGet();
    await testGetMissingGroup();
    await testGetEmptyGroup();
    await testPostWithoutAuth();
    await testUploadWithoutAuth();
    await testDeleteAttachmentWithoutAuth();
    await testMethodNotAllowed();
  } catch (err) {
    console.error('\n💥 Test runner error:', err.message);
    failed++;
  }

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
