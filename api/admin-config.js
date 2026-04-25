/**
 * Admin endpoints combined (Vercel Hobby plan limit: 12 serverless functions).
 *
 * Routes:
 *   GET  /api/admin-config                   → verify admin credentials (auth probe)
 *   POST /api/admin-config?action=publish    → push schedule.json to GitHub via server token
 *
 * Auth (for every route): X-Admin-Pin header + Authorization: Bearer <admin session token>
 */
const crypto = require('crypto');
const { redis, rateLimit, safeCompare, getSessionUsername } = require('./_lib/redis');

const ADMIN_PIN = process.env.ADMIN_PIN;
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_OWNER = process.env.GITHUB_OWNER || 'nazarn1xyy';
const GH_REPO = process.env.GITHUB_REPO || 'mpmek';
const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const STAROSTA_ACCOUNTS = {};
(process.env.STAROSTA_ACCOUNTS || '').split(',').map(s => s.trim()).filter(Boolean).forEach(entry => {
  const sep = entry.indexOf(':');
  if (sep > 0) {
    const u = entry.slice(0, sep).trim().toLowerCase();
    const g = entry.slice(sep + 1).trim();
    if (u && g) STAROSTA_ACCOUNTS[u] = g;
  }
});

function pbkdf2(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, 600000, 64, 'sha512', (err, key) => {
      if (err) reject(err);
      else resolve(key.toString('hex'));
    });
  });
}

async function hasAdminSession(req) {
  const uname = await getSessionUsername(req);
  if (!uname) return false;
  return ADMIN_USERNAMES.includes(uname);
}

async function ghFetch(filePath) {
  const resp = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${filePath}`,
    {
      headers: {
        Authorization: `token ${GH_TOKEN}`,
        'User-Agent': 'mpmek-admin',
        Accept: 'application/vnd.github.v3+json'
      }
    }
  );
  if (!resp.ok) throw new Error(`GitHub fetch ${filePath}: ${resp.status}`);
  return resp.json();
}

async function ghPut(filePath, content, sha, message) {
  const encoded = Buffer.from(content, 'utf-8').toString('base64');
  const resp = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${filePath}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `token ${GH_TOKEN}`,
        'User-Agent': 'mpmek-admin',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ message, content: encoded, sha })
    }
  );
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    const e = new Error(`GitHub put ${filePath}: ${err.message || resp.status}`);
    e.status = resp.status;
    throw e;
  }
  return resp.json();
}

// Push with retry on 409 (concurrent admin conflict).
// Uses a "transform" callback so retry merges against the latest SHA.
async function ghPutWithRetry(filePath, transform, message, maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const info = await ghFetch(filePath);
      const currentContent = Buffer.from(info.content, 'base64').toString('utf-8');
      const newContent = await transform(currentContent);
      if (newContent === null) return null; // transform requested abort
      return await ghPut(filePath, newContent, info.sha, message);
    } catch (e) {
      lastErr = e;
      if (e.status !== 409 && e.status !== 422) throw e;
      // Exponential backoff: 250ms, 500ms, 1000ms
      await new Promise(r => setTimeout(r, 250 * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
}

// Validate incoming schedule structure (hardening against malicious payloads)
function validateSchedule(data) {
  if (!data || typeof data !== 'object') return 'Schedule must be object';
  const keys = Object.keys(data);
  if (keys.length > 500) return 'Too many groups (max 500)';
  const stringified = JSON.stringify(data);
  if (stringified.length > 2_000_000) return 'Schedule too large (max 2MB)';

  for (const groupName of keys) {
    if (groupName.length > 80) return `Group name too long: ${groupName}`;
    if (groupName === '_settings') continue;
    const groupData = data[groupName];
    if (!groupData || typeof groupData !== 'object') return `Invalid group data: ${groupName}`;
    for (const weekType of Object.keys(groupData)) {
      if (weekType.length > 80) return `Week type too long in ${groupName}`;
      const weekData = groupData[weekType];
      if (weekType === 'ПІДВІСКА') {
        if (!Array.isArray(weekData)) return `ПІДВІСКА must be array in ${groupName}`;
        if (weekData.length > 200) return `Too many підвіска entries in ${groupName}`;
        continue;
      }
      if (typeof weekData !== 'object') continue;
      for (const day of Object.keys(weekData)) {
        if (day.length > 20) return `Day name too long in ${groupName}/${weekType}`;
        const lessons = weekData[day];
        if (!Array.isArray(lessons)) return 'Lessons must be array';
        if (lessons.length > 20) return 'Too many lessons per day';
        for (const l of lessons) {
          if (!l || typeof l !== 'object') return 'Invalid lesson';
          if (typeof l.subject === 'string' && l.subject.length > 200) return 'Subject too long';
          if (typeof l.teacher === 'string' && l.teacher.length > 100) return 'Teacher too long';
          if (typeof l.room === 'string' && l.room.length > 30) return 'Room too long';
        }
      }
    }
  }
  return null;
}

async function handlePublish(req, res) {
  if (!GH_TOKEN) {
    return res.status(500).json({ error: 'Server not configured (GITHUB_TOKEN missing)' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (await rateLimit(`publish:${ip}`, 10, 60)) {
    return res.status(429).json({ error: 'Забагато публікацій. Зачекайте хвилину' });
  }

  const { schedule } = req.body || {};
  const validationError = validateSchedule(schedule);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const newContent = JSON.stringify(schedule);

  // 1. Push schedule.json with retry on 409 (concurrent admin conflict)
  await ghPutWithRetry(
    'app/schedule.json',
    () => newContent,
    '📅 Оновлено розклад через адмін-панель'
  );

  // Invalidate groups cache so new groups/renames take effect immediately
  redis('DEL', 'cache:schedule-groups').catch(() => {});

  // 2. Bump SW cache version so clients fetch fresh assets
  try {
    await ghPutWithRetry(
      'app/sw.js',
      (currentSw) => {
        const match = currentSw.match(/rozklad-v(\d+)/);
        if (!match) return null;
        const newVer = parseInt(match[1], 10) + 1;
        return currentSw.replace(/rozklad-v\d+/, `rozklad-v${newVer}`);
      },
      '🔄 Бамп версії кешу SW'
    );
  } catch (e) {
    console.warn('SW bump skipped:', e.message);
  }

  return res.json({ ok: true });
}

async function handleUsers(res) {
  const keys = await redis('KEYS', 'auth:user:*');
  const values = keys && keys.length ? await redis('MGET', ...keys) : [];
  const usersMap = {};
  (keys || []).forEach((key, i) => {
    const username = key.replace('auth:user:', '');
    try {
      const d = JSON.parse(values[i]);
      usersMap[username] = {
        username,
        displayName: d.displayName || username,
        group: d.group || '',
        role: ADMIN_USERNAMES.includes(username) ? 'admin' : (d.role || 'user'),
        createdAt: d.createdAt || null,
        envStarosta: !!STAROSTA_ACCOUNTS[username]
      };
    } catch {
      usersMap[username] = { username, displayName: username, group: '', role: 'user', createdAt: null };
    }
  });
  for (const [u, g] of Object.entries(STAROSTA_ACCOUNTS)) {
    if (!usersMap[u]) {
      usersMap[u] = { username: u, displayName: u, group: g, role: 'starosta', createdAt: null, envStarosta: true };
    } else if (usersMap[u].role !== 'admin') {
      usersMap[u].envStarosta = true;
      usersMap[u].role = 'starosta';
      usersMap[u].group = usersMap[u].group || g;
    }
  }
  const users = Object.values(usersMap);
  users.sort((a, b) => {
    const ro = { admin: 0, starosta: 1, user: 2 };
    return (ro[a.role] ?? 3) - (ro[b.role] ?? 3) || a.username.localeCompare(b.username);
  });
  return res.json({ users, total: users.length });
}

async function handleSetRole(req, res) {
  const { username, role, group } = req.body || {};
  const uname = (username || '').trim().toLowerCase();
  if (!uname) return res.status(400).json({ error: 'Username required' });
  if (!['user', 'starosta'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (ADMIN_USERNAMES.includes(uname)) return res.status(403).json({ error: 'Cannot modify admin' });
  const raw = await redis('GET', `auth:user:${uname}`);
  if (!raw) return res.status(404).json({ error: 'User not found' });
  const userData = JSON.parse(raw);
  if (role === 'starosta') {
    userData.role = 'starosta';
    if (group) userData.group = group;
  } else {
    delete userData.role;
  }
  await redis('SET', `auth:user:${uname}`, JSON.stringify(userData));
  return res.json({ ok: true });
}

async function handleCreateStarosta(req, res) {
  const { username, password, displayName, group } = req.body || {};
  const uname = (username || '').trim().toLowerCase();
  const pwd = password || '';
  const name = (displayName || '').trim();
  const grp = (group || '').trim();
  if (!uname || !pwd || !grp) return res.status(400).json({ error: 'Логін, пароль і група обов\'язкові' });
  if (uname.length < 3 || !/^[a-z0-9_]+$/.test(uname)) return res.status(400).json({ error: 'Логін: від 3 символів, латиниця/цифри/_' });
  if (pwd.length < 4) return res.status(400).json({ error: 'Пароль: мінімум 4 символи' });
  if (ADMIN_USERNAMES.includes(uname)) return res.status(403).json({ error: 'Логін зарезервовано' });
  const existing = await redis('GET', `auth:user:${uname}`);
  if (existing) return res.status(409).json({ error: 'Користувач вже існує' });
  const salt = crypto.randomBytes(32).toString('hex');
  const hash = await pbkdf2(pwd, salt);
  const userData = { displayName: name || uname, passwordHash: hash, salt, group: grp, role: 'starosta', createdAt: new Date().toISOString() };
  await redis('SET', `auth:user:${uname}`, JSON.stringify(userData));
  return res.json({ ok: true, username: uname });
}

async function handleDeleteUser(req, res) {
  const { username } = req.body || {};
  const uname = (username || '').trim().toLowerCase();
  if (!uname) return res.status(400).json({ error: 'Username required' });
  if (ADMIN_USERNAMES.includes(uname)) return res.status(403).json({ error: 'Cannot delete admin' });
  await redis('DEL', `auth:user:${uname}`);
  await redis('DEL', `auth:sver:${uname}`);
  return res.json({ ok: true });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://mpmek.site');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Pin, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Rate limit PIN attempts (anti brute-force) — per IP + global (botnet protection)
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (await rateLimit(`admin:${ip}`, 10, 300)) {
    return res.status(429).json({ error: 'Too many attempts. Wait 5 minutes' });
  }
  if (await rateLimit('admin:global:5m', 100, 300)) {
    return res.status(429).json({ error: 'Забагато спроб. Зачекайте' });
  }
  // 1-hour global cap (stops slow distributed brute-force)
  if (await rateLimit('admin:global:1h', 500, 3600)) {
    return res.status(429).json({ error: 'Адмін-панель тимчасово заблокована. Спробуйте пізніше' });
  }

  // Require PIN + admin session for EVERY route
  if (!ADMIN_PIN) {
    return res.status(500).json({ error: 'ADMIN_PIN not configured' });
  }

  // Per-account (session-tied) lockout: resist botnet brute-force even if
  // the attacker rotates through many IPs while holding a valid admin session.
  const bearerToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').slice(0, 128);
  if (bearerToken) {
    const lockKey = `admin:pin-fail:${bearerToken.slice(0, 16)}`;
    const fails = parseInt(await redis('GET', lockKey), 10) || 0;
    if (fails >= 20) {
      return res.status(429).json({ error: 'Акаунт заблоковано на 15 хв через забагато невдалих спроб' });
    }
  }

  const pin = req.headers['x-admin-pin'];
  if (!safeCompare(pin, ADMIN_PIN)) {
    // Record failure per-session to trigger lockout
    if (bearerToken) {
      const lockKey = `admin:pin-fail:${bearerToken.slice(0, 16)}`;
      try {
        const fails = await redis('INCR', lockKey);
        if (fails === 1) await redis('EXPIRE', lockKey, 900); // 15 min
      } catch { /* ignore */ }
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!(await hasAdminSession(req))) {
    return res.status(403).json({ error: 'Admin session required' });
  }

  // Success → clear failure counter
  if (bearerToken) {
    redis('DEL', `admin:pin-fail:${bearerToken.slice(0, 16)}`).catch(() => {});
  }

  try {
    const action = req.query.action;

    if (req.method === 'POST' && action === 'publish') return await handlePublish(req, res);
    if (req.method === 'GET' && action === 'users') return await handleUsers(res);
    if (req.method === 'POST' && action === 'set-role') return await handleSetRole(req, res);
    if (req.method === 'POST' && action === 'create-starosta') return await handleCreateStarosta(req, res);
    if (req.method === 'POST' && action === 'delete-user') return await handleDeleteUser(req, res);
    if (req.method === 'GET' && !action) return res.status(200).json({ ok: true });

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('admin-config error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
