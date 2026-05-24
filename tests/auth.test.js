/**
 * Integration tests for the auth API (/api/auth).
 * 
 * Run: node tests/auth.test.js
 * 
 * Requires the site to be running (either locally or production).
 * Set TEST_BASE_URL environment variable if not using production.
 */
const BASE = process.env.TEST_BASE_URL || 'https://mpmek.site';
const API = `${BASE}/api/auth`;

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

async function testVapidKey() {
  console.log('\n── VAPID key (public, no auth) ──');
  const { status, data } = await jsonReq(`${API}?action=vapid-key`);
  assert(status === 200 || status === 500, 'Returns 200 or 500 (if not configured)');
  if (status === 200) {
    assert(typeof data.publicKey === 'string' && data.publicKey.length > 10, 'Returns publicKey string');
  }
}

async function testRegisterValidation() {
  console.log('\n── Register validation ──');

  // Missing fields
  let r = await jsonReq(`${API}?action=register`, { method: 'POST', body: {} });
  assert(r.status === 400, 'Rejects empty body');

  // Short username
  r = await jsonReq(`${API}?action=register`, { method: 'POST', body: { username: 'ab', password: 'Test1234', displayName: 'Test' } });
  assert(r.status === 400, 'Rejects username < 3 chars');

  // Invalid username chars
  r = await jsonReq(`${API}?action=register`, { method: 'POST', body: { username: 'Тест123', password: 'Test1234', displayName: 'Test' } });
  assert(r.status === 400, 'Rejects non-latin username');

  // Short password
  r = await jsonReq(`${API}?action=register`, { method: 'POST', body: { username: 'testuser_' + Date.now(), password: 'short', displayName: 'Test' } });
  assert(r.status === 400, 'Rejects password < 8 chars');

  // Password without digit
  r = await jsonReq(`${API}?action=register`, { method: 'POST', body: { username: 'testuser_' + Date.now(), password: 'NoDigitsHere', displayName: 'Test' } });
  assert(r.status === 400, 'Rejects password without digit');

  // Short display name
  r = await jsonReq(`${API}?action=register`, { method: 'POST', body: { username: 'testuser_' + Date.now(), password: 'Test1234', displayName: 'A' } });
  assert(r.status === 400, 'Rejects displayName < 2 chars');
}

async function testLoginValidation() {
  console.log('\n── Login validation ──');

  // Missing credentials
  let r = await jsonReq(`${API}?action=login`, { method: 'POST', body: {} });
  assert(r.status === 400, 'Rejects empty body');

  // Wrong credentials
  r = await jsonReq(`${API}?action=login`, { method: 'POST', body: { username: 'nonexistent_user_xyz', password: 'WrongPass1' } });
  assert(r.status === 401, 'Returns 401 for wrong credentials');

  // Error message doesn't leak user existence
  assert(r.data.error && !r.data.error.includes('не існує'), 'Error message does not reveal user existence');
}

async function testMeWithoutAuth() {
  console.log('\n── Me (no auth) ──');
  const r = await jsonReq(`${API}?action=me`);
  assert(r.status === 401, 'Returns 401 without auth token');
}

async function testMethodNotAllowed() {
  console.log('\n── Method restrictions ──');
  const r = await jsonReq(API, { method: 'DELETE' });
  assert(r.status === 405 || r.status === 400, 'Rejects DELETE method');
}

async function testUnknownAction() {
  console.log('\n── Unknown action ──');
  const r = await jsonReq(`${API}?action=doesnotexist`, { method: 'POST', body: {} });
  assert(r.status === 400, 'Returns 400 for unknown action');
}

async function testRateLimit() {
  console.log('\n── Rate limiting ──');
  // Send multiple rapid login attempts — should eventually get 429
  let got429 = false;
  for (let i = 0; i < 15; i++) {
    const r = await jsonReq(`${API}?action=login`, {
      method: 'POST',
      body: { username: `ratelimit_test_${Date.now()}`, password: 'WrongPass1' }
    });
    if (r.status === 429) {
      got429 = true;
      break;
    }
  }
  assert(got429, 'Rate limit triggers after repeated attempts');
}

async function testSetgroupWithoutAuth() {
  console.log('\n── Setgroup (no auth) ──');
  const r = await jsonReq(`${API}?action=setgroup`, { method: 'POST', body: { group: 'КСМ-24-1' } });
  assert(r.status === 401, 'Returns 401 without auth');
}

async function testLogoutWithoutSession() {
  console.log('\n── Logout (no session) ──');
  const r = await jsonReq(`${API}?action=logout`, { method: 'POST', body: {} });
  assert(r.status === 200, 'Logout succeeds even without session (graceful)');
}

// ── Run all ──
(async () => {
  console.log(`\n🧪 Auth API Integration Tests — ${BASE}\n`);

  try {
    await testVapidKey();
    await testRegisterValidation();
    await testLoginValidation();
    await testMeWithoutAuth();
    await testMethodNotAllowed();
    await testUnknownAction();
    await testSetgroupWithoutAuth();
    await testLogoutWithoutSession();
    // Run rate limit test last (it may affect other tests)
    await testRateLimit();
  } catch (err) {
    console.error('\n💥 Test runner error:', err.message);
    failed++;
  }

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
