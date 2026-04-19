const crypto = require('crypto');

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

// Rate limiter: returns true if request should be blocked.
// Atomic pattern: SET NX EX + INCR. Even if crash between ops, the key has TTL.
// Defensive: if for any reason count reaches 1 without TTL set, set it explicitly.
async function rateLimit(key, maxAttempts, windowSec) {
  const rk = `rl:${key}`;
  // Upstash REST may return 'OK', true, or null depending on client version.
  // "Key was created" = any truthy result. "Key existed" = null/undefined/false.
  let created = false;
  try {
    const setResult = await redis('SET', rk, '0', 'EX', windowSec, 'NX');
    created = setResult === 'OK' || setResult === true;
  } catch { /* ignore, fall through */ }

  const count = await redis('INCR', rk);

  // Guarantee TTL: if not the one that created the key, or INCR pushed count to 1
  // without our creator flag (race), set TTL defensively. TTL re-setting is idempotent.
  if (!created || count === 1) {
    try { await redis('EXPIRE', rk, windowSec); } catch { /* ignore */ }
  }

  return count > maxAttempts;
}

// Sanitize string for safe Redis key usage — strip control chars and limit length
function safeKey(str, maxLen = 50) {
  if (typeof str !== 'string') return '';
  return str.replace(/[\x00-\x1f\x7f\s]/g, '').slice(0, maxLen);
}

// Timing-safe string comparison (prevents timing attacks on secrets)
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Extract username from Bearer token (handles both "username" legacy and "username:sessionVer" formats)
// Returns null if token invalid, session not found, or sessionVer mismatch.
async function getSessionUsername(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  if (!token || token.length > 128) return null;
  const raw = await redis('GET', `auth:session:${token}`);
  if (!raw) return null;
  const colonIdx = raw.indexOf(':');
  const uname = colonIdx > 0 ? raw.slice(0, colonIdx) : raw;
  const ver = colonIdx > 0 ? raw.slice(colonIdx + 1) : null;
  if (ver) {
    const currentVer = await redis('GET', `auth:sver:${uname}`);
    if (currentVer && ver !== currentVer) return null;
  }
  return uname;
}

module.exports = { redis, parseRedisHash, parseRedisEntries, rateLimit, safeKey, safeCompare, getSessionUsername };
