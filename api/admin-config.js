const { redis } = require('./_lib/redis');

const ADMIN_PIN = '0411';
const REDIS_KEY = 'admin-config';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://mpmek.site');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Pin');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Simple auth check
  const pin = req.headers['x-admin-pin'];
  if (pin !== ADMIN_PIN) {
    return res.status(401).json({ error: 'Unauthorized' });
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
