const { redis, parseRedisHash, rateLimit, safeKey } = require('./_lib/redis');

const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// Authenticate via Bearer token, return { username, group, isAdmin } or null
async function authenticate(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  if (!token || token.length > 128) return null;
  const uname = await redis('GET', `auth:session:${token}`);
  if (!uname) return null;
  const raw = await redis('GET', `auth:user:${uname}`);
  if (!raw) return null;
  try {
    const user = JSON.parse(raw);
    return { username: uname, group: user.group || '', isAdmin: ADMIN_USERNAMES.includes(uname) };
  } catch { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://mpmek.site');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';

  try {
    if (req.method === 'GET') {
      // GET is public — anyone in the group can read collaborative homework
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

    // Write operations require authentication
    if (req.method === 'POST' || req.method === 'DELETE') {
      const user = await authenticate(req);
      if (!user) {
        return res.status(401).json({ error: 'Авторизуйтесь, щоб редагувати завдання' });
      }

      if (await rateLimit(`hw:${user.username}`, 30, 60)) {
        return res.status(429).json({ error: 'Too many requests' });
      }
      if (await rateLimit(`hw:ip:${ip}`, 60, 60)) {
        return res.status(429).json({ error: 'Too many requests' });
      }

      const source = req.method === 'POST' ? (req.body || {}) : (req.query || {});
      const { group, day, number, text } = source;

      if (!group || !day || number === undefined) {
        return res.status(400).json({ error: 'group, day, number required' });
      }
      if (typeof group !== 'string' || group.length > 50) return res.status(400).json({ error: 'invalid group' });
      if (typeof day !== 'string' || day.length > 20) return res.status(400).json({ error: 'invalid day' });

      // Users can only modify homework for their own group; admins can modify any
      if (!user.isAdmin && user.group !== group) {
        return res.status(403).json({ error: 'Можна редагувати тільки свою групу' });
      }

      const num = Number(number);
      if (!Number.isFinite(num) || num < 1 || num > 8) {
        return res.status(400).json({ error: 'invalid number' });
      }

      const sg = safeKey(group);
      const field = `${safeKey(day, 20)}:${num}`;

      if (req.method === 'POST') {
        if (text !== undefined && typeof text !== 'string') {
          return res.status(400).json({ error: 'text must be string' });
        }
        if (text && text.length > 1000) return res.status(400).json({ error: 'text too long' });

        if (text && text.trim()) {
          await redis('HSET', `hw:${sg}`, field, text.trim().slice(0, 1000));
        } else {
          await redis('HDEL', `hw:${sg}`, field);
        }
      } else {
        await redis('HDEL', `hw:${sg}`, field);
      }
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    console.error('homework API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
