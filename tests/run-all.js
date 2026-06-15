/**
 * Run all API integration tests sequentially.
 * 
 * Usage: node tests/run-all.js
 * 
 * Set TEST_BASE_URL to test against a local/staging server:
 *   TEST_BASE_URL=http://localhost:3000 node tests/run-all.js
 */
const { execSync } = require('child_process');
const path = require('path');

const tests = [
  'unit.test.js',
  'auth.test.js',
  'homework.test.js',
  'push.test.js',
  'pidveska.test.js',
];

const dir = __dirname;
let totalFailed = 0;

console.log('━'.repeat(50));
console.log('  API Integration Test Suite');
console.log('━'.repeat(50));

for (const file of tests) {
  const filePath = path.join(dir, file);
  try {
    execSync(`node "${filePath}"`, {
      stdio: 'inherit',
      env: { ...process.env }
    });
  } catch (e) {
    totalFailed++;
  }
}

console.log('\n' + '━'.repeat(50));
if (totalFailed === 0) {
  console.log('  ✅ All test suites passed');
} else {
  console.log(`  ❌ ${totalFailed} test suite(s) failed`);
}
console.log('━'.repeat(50));
process.exit(totalFailed > 0 ? 1 : 0);
