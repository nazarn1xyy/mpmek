const crypto = require('crypto');
const { redis, rateLimit } = require('./_lib/redis');
const { encryptSubscription } = require('./_lib/push-crypto');

async function getSession(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  if (!token || token.length > 128) return null;
  const uname = await redis('GET', `auth:session:${token}`);
  return uname || null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://mpmek.site');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Require authenticated session for push management
  const user = await getSession(req);
  if (!user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const action = req.query.action;

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';

  try {
    if (action === 'subscribe') {
      if (await rateLimit(`push:${ip}`, 10, 60)) {
        return res.status(429).json({ error: 'Too many requests' });
      }
      const { subscription, group, notifyTime } = req.body || {};
      if (!subscription || typeof subscription !== 'object' || typeof subscription.endpoint !== 'string') {
        return res.status(400).json({ error: 'Invalid subscription' });
      }
      if (subscription.endpoint.length > 500) {
        return res.status(400).json({ error: 'Endpoint too long' });
      }
      if (typeof group !== 'string' || group.length === 0 || group.length > 80) {
        return res.status(400).json({ error: 'Invalid group' });
      }
      const nt = typeof notifyTime === 'string' && /^\d{2}:\d{2}$/.test(notifyTime) ? notifyTime : '08:00';

      const id = crypto
        .createHash('sha256')
        .update(subscription.endpoint)
        .digest('hex')
        .slice(0, 16);

      // Encrypt subscription at rest (falls back to plaintext if key not configured)
      const encPayload = encryptSubscription(subscription);
      await redis('HSET', 'push-subs', id, JSON.stringify({
        ...encPayload,
        group: group.slice(0, 80),
        notifyTime: nt
      }));

      return res.status(200).json({ ok: true, id });
    }

    if (action === 'unsubscribe') {
      if (await rateLimit(`push:${ip}`, 10, 60)) {
        return res.status(429).json({ error: 'Too many requests' });
      }
      const { endpoint } = req.body;
      if (!endpoint) {
        return res.status(400).json({ error: 'Missing endpoint' });
      }

      const id = crypto
        .createHash('sha256')
        .update(endpoint)
        .digest('hex')
        .slice(0, 16);

      await redis('HDEL', 'push-subs', id);

      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (error) {
    console.error('Push error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
