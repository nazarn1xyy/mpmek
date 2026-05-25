/**
 * Integration tests for the pidveska API (/api/pidveska).
 * 
 * Run: node tests/pidveska.test.js
 * 
 * Requires the site to be running.
 * Set TEST_BASE_URL environment variable if not using production.
 */
const BASE = process.env.TEST_BASE_URL || 'https://mpmek.site';
const API = `${BASE}/api/pidveska`;

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
  return { status: resp.status, data };
}

async function testPostWithoutAuth() {
  console.log('\n── Pidveska POST (no auth) ──');
  const r = await jsonReq(API, {
    method: 'POST',
    body: {
      group: 'КСМ-2024-1',
      date: '01.06',
      number: 1,
      subject: 'Тест',
      teacher: 'Тестовий'
    }
  });
  assert(r.status === 401 || r.status === 403, 'Rejects POST without auth');
}

async function testDeleteWithoutAuth() {
  console.log('\n── Pidveska DELETE (no auth) ──');
  const r = await jsonReq(API, {
    method: 'DELETE',
    body: {
      group: 'КСМ-2024-1',
      date: '01.06',
      number: 1
    }
  });
  assert(r.status === 401 || r.status === 403, 'Rejects DELETE without auth');
}

async function testPostWithInvalidToken() {
  console.log('\n── Pidveska POST (invalid token) ──');
  const r = await jsonReq(API, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer fake_invalid_token' },
    body: {
      group: 'КСМ-2024-1',
      date: '01.06',
      number: 1,
      subject: 'Тест',
      teacher: 'Тестовий'
    }
  });
  assert(r.status === 401 || r.status === 403, 'Rejects POST with invalid token');
}

async function testPostMissingFields() {
  console.log('\n── Pidveska POST (missing fields, with fake auth) ──');
  const r = await jsonReq(API, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer fake_invalid_token' },
    body: { group: 'КСМ-2024-1' }
  });
  // 401 (invalid token) or 400 (missing fields) — either is acceptable
  assert(r.status === 400 || r.status === 401, 'Returns 400 or 401 for missing fields');
}

async function testGetNotAllowed() {
  console.log('\n── Pidveska GET method ──');
  const r = await jsonReq(API);
  assert(r.status === 405, 'Rejects GET method');
}

// ── Run all ──
(async () => {
  console.log(`\n🧪 Pidveska API Integration Tests — ${BASE}\n`);

  try {
    await testPostWithoutAuth();
    await testDeleteWithoutAuth();
    await testPostWithInvalidToken();
    await testPostMissingFields();
    await testGetNotAllowed();
  } catch (err) {
    console.error('\n💥 Test runner error:', err.message);
    failed++;
  }

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
