const crypto = require('crypto');
const { redis, rateLimit } = require('./_lib/redis');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const action = req.query.action;

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';

  try {
    if (action === 'subscribe') {
      if (await rateLimit(`push:${ip}`, 10, 60)) {
        return res.status(429).json({ error: 'Too many requests' });
      }
      const { subscription, group, notifyTime } = req.body;
      if (!subscription || !subscription.endpoint || !group) {
        return res.status(400).json({ error: 'Missing subscription or group' });
      }

      const id = crypto
        .createHash('sha256')
        .update(subscription.endpoint)
        .digest('hex')
        .slice(0, 16);

      await redis('HSET', 'push-subs', id, JSON.stringify({
        subscription,
        group,
        notifyTime: notifyTime || '08:00'
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
