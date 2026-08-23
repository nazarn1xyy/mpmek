const crypto = require('crypto');
const { redis } = require('./_lib/redis');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://mpmek.site');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const isUnsubscribe = req.method === 'DELETE' || 
                        req.query.action === 'unsubscribe' || 
                        (req.body && req.body.action === 'unsubscribe') ||
                        (req.body && req.body.endpoint && !req.body.subscription);

  try {
    if (isUnsubscribe) {
      const { endpoint } = req.body || {};
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

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const { subscription, group, notifyTime } = req.body || {};
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
  } catch (error) {
    console.error('Subscribe/Unsubscribe error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
