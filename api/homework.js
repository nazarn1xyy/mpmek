const { redis, parseRedisHash } = require('./_lib/redis');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://mpmek.site');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const { group } = req.query;
      if (!group) return res.status(400).json({ error: 'group is required' });

      const raw = await redis('HGETALL', `hw:${group}`);
      const hash = parseRedisHash(raw);
      const result = {};
      for (const [field, value] of Object.entries(hash)) {
        const [day, num] = field.split(':');
        result[`${group}|${day}|${num}`] = value;
      }
      return res.json(result);
    }

    if (req.method === 'POST') {
      const { group, day, number, text } = req.body;
      if (!group || !day || number === undefined) {
        return res.status(400).json({ error: 'group, day, number required' });
      }

      const field = `${day}:${number}`;
      if (text && text.trim()) {
        await redis('HSET', `hw:${group}`, field, text.trim());
      } else {
        await redis('HDEL', `hw:${group}`, field);
      }
      return res.json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const { group, day, number } = req.query;
      if (!group || !day || number === undefined) {
        return res.status(400).json({ error: 'group, day, number required' });
      }

      const field = `${day}:${number}`;
      await redis('HDEL', `hw:${group}`, field);
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    console.error('homework API error:', err);
    return res.status(500).json({ error: err.message });
  }
};
