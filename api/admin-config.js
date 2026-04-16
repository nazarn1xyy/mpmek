const { redis, rateLimit, safeCompare } = require('./_lib/redis');

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const REDIS_KEY = 'admin-config';

// Check if request has valid admin session (Bearer token from /api/auth)
async function hasAdminSession(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  if (!token || token.length > 128) return false;
  const uname = await redis('GET', `auth:session:${token}`);
  if (!uname) return false;
  return ADMIN_USERNAMES.includes(uname);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://mpmek.site');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Pin, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Rate limit PIN attempts (anti brute-force) — per IP and globally
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (await rateLimit(`admin:${ip}`, 5, 300)) {
    return res.status(429).json({ error: 'Too many attempts. Wait 5 minutes' });
  }
  if (await rateLimit('admin:global', 50, 300)) {
    return res.status(429).json({ error: 'Забагато спроб. Зачекайте' });
  }

  // Require PIN
  if (!ADMIN_PIN) {
    return res.status(500).json({ error: 'ADMIN_PIN not configured' });
  }
  const pin = req.headers['x-admin-pin'];
  if (!safeCompare(pin, ADMIN_PIN)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Require admin session (Bearer token with admin role)
  const isAdmin = await hasAdminSession(req);
  if (!isAdmin) {
    return res.status(403).json({ error: 'Admin session required' });
  }

  try {
    if (req.method === 'GET') {
      const raw = await redis('GET', REDIS_KEY);
      const config = raw ? JSON.parse(raw) : {};
      return res.status(200).json(config);
    }

    if (req.method === 'POST') {
      const { ghToken, ghOwner, ghRepo } = req.body || {};
      const config = {
        ghToken: typeof ghToken === 'string' ? ghToken.slice(0, 200) : '',
        ghOwner: typeof ghOwner === 'string' ? ghOwner.slice(0, 100) : '',
        ghRepo: typeof ghRepo === 'string' ? ghRepo.slice(0, 100) : ''
      };
      await redis('SET', REDIS_KEY, JSON.stringify(config));
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Admin config error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
