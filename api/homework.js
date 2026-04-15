const { redis, parseRedisHash, rateLimit, safeKey } = require('./_lib/redis');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://mpmek.site');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';

  try {
    if (req.method === 'GET') {
      const { group } = req.query;
      if (!group) return res.status(400).json({ error: 'group is required' });
      if (typeof group !== 'string' || group.length > 50) return res.status(400).json({ error: 'invalid group' });

      const raw = await redis('HGETALL', `hw:${safeKey(group)}`);
      const hash = parseRedisHash(raw);
      const result = {};
      for (const [field, value] of Object.entries(hash)) {
        const [day, num] = field.split(':');
        result[`${group}|${day}|${num}`] = value;
      }
      return res.json(result);
    }

    if (req.method === 'POST') {
      if (await rateLimit(`hw:${ip}`, 30, 60)) {
        return res.status(429).json({ error: 'Too many requests' });
      }
      const { group, day, number, text } = req.body;
      if (!group || !day || number === undefined) {
        return res.status(400).json({ error: 'group, day, number required' });
      }
      if (typeof group !== 'string' || group.length > 50) return res.status(400).json({ error: 'invalid group' });
      if (typeof day !== 'string' || day.length > 20) return res.status(400).json({ error: 'invalid day' });
      if (text && typeof text === 'string' && text.length > 1000) return res.status(400).json({ error: 'text too long' });

      const sg = safeKey(group);
      const field = `${safeKey(day, 20)}:${Number(number) || 0}`;
      if (text && text.trim()) {
        await redis('HSET', `hw:${sg}`, field, text.trim().slice(0, 1000));
      } else {
        await redis('HDEL', `hw:${sg}`, field);
      }
      return res.json({ ok: true });
    }

    if (req.method === 'DELETE') {
      if (await rateLimit(`hw:${ip}`, 30, 60)) {
        return res.status(429).json({ error: 'Too many requests' });
      }
      const { group, day, number } = req.query;
      if (!group || !day || number === undefined) {
        return res.status(400).json({ error: 'group, day, number required' });
      }

      const field = `${safeKey(day, 20)}:${Number(number) || 0}`;
      await redis('HDEL', `hw:${safeKey(group)}`, field);
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    console.error('homework API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
