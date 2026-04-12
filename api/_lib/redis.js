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

module.exports = { redis, parseRedisHash, parseRedisEntries };
