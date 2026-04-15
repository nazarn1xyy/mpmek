const REDIS_URL = process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN;

async function redis(...args) {
  const resp = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args)
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

function parseRedisHash(raw) {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    const result = {};
    for (let i = 0; i < raw.length; i += 2) result[raw[i]] = raw[i + 1];
    return result;
  }
  if (typeof raw === 'object') return raw;
  return {};
}

function parseRedisEntries(raw) {
  const hash = parseRedisHash(raw);
  const entries = [];
  for (const [id, json] of Object.entries(hash)) {
    try {
      entries.push({ id, ...JSON.parse(json) });
    } catch { /* skip malformed */ }
  }
  return entries;
}

// Rate limiter: returns true if request should be blocked
async function rateLimit(key, maxAttempts, windowSec) {
  const rk = `rl:${key}`;
  const count = await redis('INCR', rk);
  if (count === 1) await redis('EXPIRE', rk, windowSec);
  return count > maxAttempts;
}

// Sanitize string for safe Redis key usage — strip control chars and limit length
function safeKey(str, maxLen = 50) {
  if (typeof str !== 'string') return '';
  return str.replace(/[\x00-\x1f\x7f\s]/g, '').slice(0, maxLen);
}

module.exports = { redis, parseRedisHash, parseRedisEntries, rateLimit, safeKey };
