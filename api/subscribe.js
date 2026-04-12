const crypto = require('crypto');
const { redis } = require('./_lib/redis');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
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
  } catch (error) {
    console.error('Subscribe error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
