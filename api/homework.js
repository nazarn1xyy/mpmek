const { redis, parseRedisHash, rateLimit, safeKey, getSessionUsername } = require('./_lib/redis');
const { put, del } = require('@vercel/blob');

// Normalize group name to full-year format for comparison (КСМ-24-1 → КСМ-2024-1)
function normalizeGroup(g) {
  if (!g) return '';
  return g.split('-').map(p => {
    if (/^\d{2}$/.test(p) && parseInt(p) >= 20) return (parseInt(p) < 50 ? '20' : '19') + p;
    return p;
  }).join('-');
}
function sameGroup(a, b) { return normalizeGroup(a) === normalizeGroup(b); }

const MAX_FILE_SIZE = 3 * 1024 * 1024; // 3 MB
const MAX_ATTACHMENTS = 5;
const ALLOWED_TYPES = ['image/webp', 'image/jpeg', 'image/png', 'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];

const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// Authenticate via Bearer token, return { username, group, isAdmin } or null
async function authenticate(req) {
  const uname = await getSessionUsername(req);
  if (!uname) return null;
  const raw = await redis('GET', `auth:user:${uname}`);
  if (!raw) return null;
  try {
    const user = JSON.parse(raw);
    const isAdmin = ADMIN_USERNAMES.includes(uname) || user.role === 'starosta';
    return { username: uname, group: user.group || '', isAdmin };
  } catch { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://mpmek.site');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';

  try {
    const action = req.query.action;

    if (req.method === 'GET' && !action) {
      // GET is public — anyone in the group can read collaborative homework
      const { group } = req.query;
      if (!group) return res.status(400).json({ error: 'group is required' });
      if (typeof group !== 'string' || group.length > 50) return res.status(400).json({ error: 'invalid group' });

      const ng = normalizeGroup(group);
      const hwKey = `hw:${safeKey(ng)}`;
      let raw = await redis('HGETALL', hwKey);
      let hash = parseRedisHash(raw);

      // One-time migration: move data from old key to normalized key
      if (Object.keys(hash).length === 0 && ng !== group) {
        const oldRaw = await redis('HGETALL', `hw:${safeKey(group)}`);
        const oldHash = parseRedisHash(oldRaw);
        if (Object.keys(oldHash).length > 0) {
          const args = [];
          for (const [f, v] of Object.entries(oldHash)) args.push(f, v);
          await redis('HSET', hwKey, ...args);
          await redis('DEL', `hw:${safeKey(group)}`);
          hash = oldHash;
        }
      }

      const result = {};
      const files = {};
      for (const [field, value] of Object.entries(hash)) {
        if (field.endsWith(':files')) {
          // attachment metadata: "day:num:files"
          const parts = field.replace(/:files$/, '').split(':');
          const key = `${group}|${parts[0]}|${parts[1]}`;
          try {
            const arr = JSON.parse(value);
            // Deduplicate by name+size (same file uploaded multiple times)
            const seen = new Set();
            files[key] = arr.filter(f => {
              const k = `${f.name}:${f.size}`;
              if (seen.has(k)) return false;
              seen.add(k);
              return true;
            });
          } catch { files[key] = []; }
        } else {
          const [day, num] = field.split(':');
          result[`${group}|${day}|${num}`] = value;
        }
      }
      return res.json({ texts: result, files });
    }

    // ── Upload attachment ──
    if (req.method === 'POST' && action === 'upload') {
      const user = await authenticate(req);
      if (!user) return res.status(401).json({ error: 'Авторизуйтесь' });
      if (await rateLimit(`hw:upload:${user.username}`, 15, 60)) {
        return res.status(429).json({ error: 'Too many uploads' });
      }

      const { group, day, number, fileName, fileType, fileData } = req.body || {};
      if (!group || !day || number === undefined || !fileData || !fileName) {
        return res.status(400).json({ error: 'group, day, number, fileName, fileData required' });
      }
      if (!user.isAdmin && !sameGroup(user.group, group)) {
        return res.status(403).json({ error: 'Можна редагувати тільки свою групу' });
      }
      const mimeType = typeof fileType === 'string' ? fileType : 'application/octet-stream';
      if (!ALLOWED_TYPES.includes(mimeType)) {
        return res.status(400).json({ error: 'Недозволений тип файлу' });
      }

      // Decode base64
      const buf = Buffer.from(fileData, 'base64');
      if (buf.length > MAX_FILE_SIZE) {
        return res.status(400).json({ error: `Файл занадто великий (макс ${MAX_FILE_SIZE / 1024 / 1024} МБ)` });
      }

      const num = Number(number);
      if (!Number.isFinite(num) || num < 1 || num > 8) {
        return res.status(400).json({ error: 'invalid number' });
      }
      const sg = safeKey(normalizeGroup(group));
      const field = `${safeKey(day, 20)}:${num}:files`;

      // Check existing attachments count
      const existingRaw = await redis('HGET', `hw:${sg}`, field);
      let existing = [];
      try { if (existingRaw) existing = JSON.parse(existingRaw); } catch {}
      if (existing.length >= MAX_ATTACHMENTS) {
        return res.status(400).json({ error: `Максимум ${MAX_ATTACHMENTS} файлів` });
      }

      // Prevent duplicate uploads (same name + same size)
      const isDuplicate = existing.some(e => e.name === fileName.slice(0, 100) && e.size === buf.length);
      if (isDuplicate) {
        return res.json({ ok: true, attachment: existing.find(e => e.name === fileName.slice(0, 100)), total: existing.length, duplicate: true });
      }

      // Upload to Vercel Blob
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
      const blobPath = `hw/${sg}/${safeKey(day, 20)}/${num}/${Date.now()}_${safeName}`;
      const blob = await put(blobPath, buf, {
        access: 'public',
        contentType: mimeType,
        addRandomSuffix: false
      });

      existing.push({ url: blob.url, name: fileName.slice(0, 100), type: mimeType, size: buf.length });
      await redis('HSET', `hw:${sg}`, field, JSON.stringify(existing));

      return res.json({ ok: true, attachment: existing[existing.length - 1], total: existing.length });
    }

    // ── Delete attachment ──
    if (req.method === 'POST' && action === 'delete-attachment') {
      const user = await authenticate(req);
      if (!user) return res.status(401).json({ error: 'Авторизуйтесь' });
      if (await rateLimit(`hw:del:${user.username}`, 30, 60)) {
        return res.status(429).json({ error: 'Too many requests' });
      }

      const { group, day, number, url } = req.body || {};
      if (!group || !day || number === undefined || !url) {
        return res.status(400).json({ error: 'group, day, number, url required' });
      }
      if (!user.isAdmin && !sameGroup(user.group, group)) {
        return res.status(403).json({ error: 'Можна редагувати тільки свою групу' });
      }
      const num = Number(number);
      if (!Number.isFinite(num) || num < 1 || num > 8) {
        return res.status(400).json({ error: 'invalid number' });
      }
      const sg = safeKey(normalizeGroup(group));
      const field = `${safeKey(day, 20)}:${num}:files`;

      const existingRaw = await redis('HGET', `hw:${sg}`, field);
      let existing = [];
      try { if (existingRaw) existing = JSON.parse(existingRaw); } catch {}

      const idx = existing.findIndex(a => a.url === url);
      if (idx === -1) return res.status(404).json({ error: 'Файл не знайдено' });

      // Delete from Vercel Blob
      try { await del(url); } catch (e) { console.warn('Blob delete failed:', e); }

      existing.splice(idx, 1);
      if (existing.length > 0) {
        await redis('HSET', `hw:${sg}`, field, JSON.stringify(existing));
      } else {
        await redis('HDEL', `hw:${sg}`, field);
      }

      return res.json({ ok: true, remaining: existing.length });
    }

    // Write operations (text) require authentication
    if ((req.method === 'POST' && !action) || req.method === 'DELETE') {
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
      if (!user.isAdmin && !sameGroup(user.group, group)) {
        return res.status(403).json({ error: 'Можна редагувати тільки свою групу' });
      }

      const num = Number(number);
      if (!Number.isFinite(num) || num < 1 || num > 8) {
        return res.status(400).json({ error: 'invalid number' });
      }

      const sg = safeKey(normalizeGroup(group));
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
