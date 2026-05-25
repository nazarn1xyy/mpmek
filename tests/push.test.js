/**
 * Integration tests for the push API (/api/push).
 * 
 * Run: node tests/push.test.js
 * 
 * Requires the site to be running.
 * Set TEST_BASE_URL environment variable if not using production.
 */
const BASE = process.env.TEST_BASE_URL || 'https://mpmek.site';
const API = `${BASE}/api/push`;

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

async function testSubscribeWithoutAuth() {
  console.log('\n── Push subscribe (no auth) ──');
  const r = await jsonReq(`${API}?action=subscribe`, {
    method: 'POST',
    body: {
      subscription: { endpoint: 'https://example.com/push/test', keys: { p256dh: 'test', auth: 'test' } },
      group: 'КСМ-2024-1',
      notifyTime: '08:00'
    }
  });
  assert(r.status === 401, 'Rejects subscribe without auth');
}

async function testUnsubscribeWithoutAuth() {
  console.log('\n── Push unsubscribe (no auth) ──');
  const r = await jsonReq(`${API}?action=unsubscribe`, {
    method: 'POST',
    body: { endpoint: 'https://example.com/push/test' }
  });
  assert(r.status === 401, 'Rejects unsubscribe without auth');
}

async function testSubscribeInvalidBody() {
  console.log('\n── Push subscribe (invalid body, with fake auth) ──');
  const r = await jsonReq(`${API}?action=subscribe`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer fake_token_xyz' },
    body: { subscription: 'not_an_object', group: 'test' }
  });
  // Should get 401 (invalid token) or 400 (invalid body)
  assert(r.status === 401 || r.status === 400, 'Rejects invalid subscription body');
}

async function testUnknownAction() {
  console.log('\n── Push unknown action ──');
  const r = await jsonReq(`${API}?action=fake`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer fake_token_xyz' },
    body: {}
  });
  assert(r.status === 400 || r.status === 401, 'Rejects unknown action');
}

async function testMethodNotAllowed() {
  console.log('\n── Push GET method ──');
  const r = await jsonReq(API);
  assert(r.status === 405, 'Rejects GET method');
}

async function testOptionsPreFlight() {
  console.log('\n── Push OPTIONS (CORS preflight) ──');
  const resp = await fetch(API, { method: 'OPTIONS' });
  assert(resp.status === 200, 'Returns 200 for OPTIONS');
  const allow = resp.headers.get('access-control-allow-methods') || '';
  assert(allow.includes('POST'), 'Allow-Methods includes POST');
}

// ── Run all ──
(async () => {
  console.log(`\n🧪 Push API Integration Tests — ${BASE}\n`);

  try {
    await testSubscribeWithoutAuth();
    await testUnsubscribeWithoutAuth();
    await testSubscribeInvalidBody();
    await testUnknownAction();
    await testMethodNotAllowed();
    await testOptionsPreFlight();
  } catch (err) {
    console.error('\n💥 Test runner error:', err.message);
    failed++;
  }

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
