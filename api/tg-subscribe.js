const { redis, safeCompare } = require('./_lib/redis');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://mpmek.site');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  try {
    const { chat_id, group, old_group, bot_token } = req.body || {};

    // Simple auth: require bot token
    const expectedToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!safeCompare(bot_token, expectedToken)) {
      return res.status(403).json({ error: 'unauthorized' });
    }

    // Validate chat_id (must be numeric, Telegram IDs are int64)
    const chatIdStr = String(chat_id || '').slice(0, 32);
    if (!chatIdStr || !/^-?\d+$/.test(chatIdStr)) {
      return res.status(400).json({ error: 'invalid chat_id' });
    }

    // Validate group names
    function validGroup(g) {
      return typeof g === 'string' && g.length > 0 && g.length <= 80 && !/[\x00-\x1f]/.test(g);
    }

    // Remove from old group if provided
    if (old_group && validGroup(old_group)) {
      await redis('SREM', `tg_subs:${old_group}`, chatIdStr);
    }

    // Add to new group
    if (group && validGroup(group)) {
      await redis('SADD', `tg_subs:${group}`, chatIdStr);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('tg-subscribe error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
