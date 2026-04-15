const { redis, rateLimit } = require('./_lib/redis');

const ADMIN_PIN = process.env.ADMIN_PIN;
const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const REDIS_KEY = 'admin-config';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://mpmek.site');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Pin, X-Device-Id');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Rate limit PIN attempts (anti brute-force)
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (await rateLimit(`admin:${ip}`, 5, 300)) {
    return res.status(429).json({ error: 'Too many attempts. Wait 5 minutes' });
  }

  // Simple auth check
  const pin = req.headers['x-admin-pin'];
  if (pin !== ADMIN_PIN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Device check — admin panel only accessible from trusted devices
  const deviceId = req.headers['x-device-id'];
  if (deviceId) {
    let trusted = false;
    for (const uname of ADMIN_USERNAMES) {
      const devices = await redis('SMEMBERS', `auth:admin-devices:${uname}`) || [];
      if (devices.includes(deviceId)) { trusted = true; break; }
    }
    if (!trusted) return res.status(403).json({ error: 'Пристрій не авторизовано' });
  } else {
    return res.status(403).json({ error: 'Потрібен ID пристрою' });
  }

  try {
    if (req.method === 'GET') {
      const raw = await redis('GET', REDIS_KEY);
      const config = raw ? JSON.parse(raw) : {};
      return res.status(200).json(config);
    }

    if (req.method === 'POST') {
      const { ghToken, ghOwner, ghRepo } = req.body;
      const config = { ghToken: ghToken || '', ghOwner: ghOwner || '', ghRepo: ghRepo || '' };
      await redis('SET', REDIS_KEY, JSON.stringify(config));
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Admin config error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
