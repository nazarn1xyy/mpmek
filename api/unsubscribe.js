const crypto = require('crypto');
const { redis } = require('./_lib/redis');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
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
  } catch (error) {
    console.error('Unsubscribe error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
