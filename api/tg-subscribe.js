const { redis } = require('./_lib/redis');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  try {
    const { chat_id, group, old_group, bot_token } = req.body;

    // Simple auth: require bot token
    const expectedToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!expectedToken || bot_token !== expectedToken) {
      return res.status(403).json({ error: 'unauthorized' });
    }

    if (!chat_id) {
      return res.status(400).json({ error: 'chat_id required' });
    }

    // Remove from old group if provided
    if (old_group) {
      await redis('SREM', `tg_subs:${old_group}`, String(chat_id));
    }

    // Add to new group
    if (group) {
      await redis('SADD', `tg_subs:${group}`, String(chat_id));
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('tg-subscribe error:', err);
    return res.status(500).json({ error: err.message });
  }
};
