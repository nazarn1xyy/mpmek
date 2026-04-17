const crypto = require('crypto');
const { redis, rateLimit, safeKey, safeCompare } = require('./_lib/redis');

const SESSION_TTL = 30 * 24 * 60 * 60; // 30 days

// Admin usernames from env (comma-separated), e.g. "nazar,admin2"
const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

function getUserRole(username) {
  return ADMIN_USERNAMES.includes(username) ? 'admin' : 'user';
}

function pbkdf2(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, 600000, 64, 'sha512', (err, key) => {
      if (err) reject(err);
      else resolve(key.toString('hex'));
    });
  });
}

function sanitize(str, maxLen) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen);
}

async function getSession(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  if (!token || token.length > 128) return null;
  const raw = await redis('GET', `auth:session:${token}`);
  if (!raw) return null;
  // Format: "username:sessionVer" (new) or "username" (legacy)
  const colonIdx = raw.indexOf(':');
  const uname = colonIdx > 0 ? raw.slice(0, colonIdx) : raw;
  const ver = colonIdx > 0 ? raw.slice(colonIdx + 1) : null;
  // Verify session version matches current (invalidates old sessions after re-login)
  if (ver) {
    const currentVer = await redis('GET', `auth:sver:${uname}`);
    if (currentVer && ver !== currentVer) return null;
  }
  return { token, username: uname };
}

async function getUser(username) {
  const raw = await redis('GET', `auth:user:${username}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

module.exports = async (req, res) => {
  // CORS for same-origin — allow only POST & GET
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const action = req.query.action;

    // ── Register ──
    if (req.method === 'POST' && action === 'register') {
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
      if (await rateLimit(`reg:${ip}`, 5, 60)) {
        return res.status(429).json({ error: 'Забагато спроб. Зачекайте хвилину' });
      }

      const username = sanitize(req.body.username, 30).toLowerCase();
      const password = req.body.password || '';
      const displayName = sanitize(req.body.displayName, 60);

      if (!username || !password || !displayName) {
        return res.status(400).json({ error: 'Всі поля обов\'язкові' });
      }
      if (username.length < 3 || !/^[a-z0-9_]+$/.test(username)) {
        return res.status(400).json({ error: 'Логін: від 3 символів, латиниця, цифри, _' });
      }
      if (password.length < 8 || password.length > 128) {
        return res.status(400).json({ error: 'Пароль: від 8 до 128 символів' });
      }
      if (!/[a-zA-Zа-яА-ЯіІїЇєЄґҐ]/.test(password) || !/\d/.test(password)) {
        return res.status(400).json({ error: 'Пароль повинен містити хоча б одну літеру та одну цифру' });
      }
      if (displayName.length < 2) {
        return res.status(400).json({ error: 'Ім\'я: мінімум 2 символи' });
      }

      // Block admin usernames from normal registration
      if (ADMIN_USERNAMES.includes(username)) {
        return res.status(403).json({ error: 'Цей логін зарезервовано' });
      }

      // Hash password first (before atomic write)
      const salt = crypto.randomBytes(32).toString('hex');
      const hash = await pbkdf2(password, salt);

      // Atomic uniqueness check + store (SETNX prevents race condition)
      const userData = {
        displayName,
        passwordHash: hash,
        salt,
        group: '',
        createdAt: new Date().toISOString()
      };
      const setResult = await redis('SET', `auth:user:${username}`, JSON.stringify(userData), 'NX');
      if (!setResult) {
        return res.status(409).json({ error: 'Цей логін вже зайнятий' });
      }

      // Create session (with version for future invalidation)
      const sessionVer = crypto.randomBytes(4).toString('hex');
      await redis('SET', `auth:sver:${username}`, sessionVer, 'EX', SESSION_TTL);
      const token = crypto.randomBytes(32).toString('hex');
      await redis('SET', `auth:session:${token}`, `${username}:${sessionVer}`);
      await redis('EXPIRE', `auth:session:${token}`, SESSION_TTL);

      return res.status(201).json({
        token,
        user: { username, displayName, group: '', role: getUserRole(username) }
      });
    }

    // ── Login ──
    if (req.method === 'POST' && action === 'login') {
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
      if (await rateLimit(`login:${ip}`, 10, 60)) {
        return res.status(429).json({ error: 'Забагато спроб. Зачекайте хвилину' });
      }

      const username = sanitize(req.body.username, 30).toLowerCase();
      const password = req.body.password || '';

      if (!username || !password) {
        return res.status(400).json({ error: 'Введіть логін і пароль' });
      }

      // Per-username rate limit (anti brute-force)
      if (await rateLimit(`login:u:${safeKey(username)}`, 5, 60)) {
        return res.status(429).json({ error: 'Забагато спроб для цього логіну' });
      }

      let user = await getUser(username);

      // Admin login: verify against env password (no password hash stored)
      if (ADMIN_USERNAMES.includes(username)) {
        const envPwd = process.env.ADMIN_PASSWORD;
        if (!envPwd || !safeCompare(password, envPwd)) {
          return res.status(401).json({ error: 'Невірний логін або пароль' });
        }

        // Auto-create admin profile record on first login (for displayName/group)
        if (!user) {
          user = { displayName: 'Адміністратор', group: '', createdAt: new Date().toISOString() };
          await redis('SET', `auth:user:${username}`, JSON.stringify(user));
        }

        // Invalidate old sessions + create new
        const sessionVer = crypto.randomBytes(4).toString('hex');
        await redis('SET', `auth:sver:${username}`, sessionVer, 'EX', SESSION_TTL);
        const token = crypto.randomBytes(32).toString('hex');
        await redis('SET', `auth:session:${token}`, `${username}:${sessionVer}`);
        await redis('EXPIRE', `auth:session:${token}`, SESSION_TTL);

        return res.json({
          token,
          user: { username, displayName: user.displayName, group: user.group || '', role: 'admin' }
        });
      } else {
        if (!user) {
          return res.status(401).json({ error: 'Невірний логін або пароль' });
        }
        const hash = await pbkdf2(password, user.salt);
        if (hash !== user.passwordHash) {
          return res.status(401).json({ error: 'Невірний логін або пароль' });
        }
      }

      // Invalidate old sessions + create new
      const sessionVer = crypto.randomBytes(4).toString('hex');
      await redis('SET', `auth:sver:${username}`, sessionVer, 'EX', SESSION_TTL);
      const token = crypto.randomBytes(32).toString('hex');
      await redis('SET', `auth:session:${token}`, `${username}:${sessionVer}`);
      await redis('EXPIRE', `auth:session:${token}`, SESSION_TTL);

      return res.json({
        token,
        user: { username, displayName: user.displayName, group: user.group || '', role: getUserRole(username) }
      });
    }

    // ── Me (validate session) ──
    if (req.method === 'GET' && action === 'me') {
      const session = await getSession(req);
      if (!session) return res.status(401).json({ error: 'Не авторизовано' });

      const user = await getUser(session.username);
      if (!user) return res.status(401).json({ error: 'Не авторизовано' });

      return res.json({
        user: {
          username: session.username,
          displayName: user.displayName,
          group: user.group || '',
          role: getUserRole(session.username)
        }
      });
    }

    // ── Set group ──
    if (req.method === 'POST' && action === 'setgroup') {
      const session = await getSession(req);
      if (!session) return res.status(401).json({ error: 'Не авторизовано' });

      // Allow empty string to clear the user's group (e.g. "Change group" button)
      const rawGroup = typeof req.body.group === 'string' ? req.body.group : '';
      const group = sanitize(rawGroup, 50);

      if (group) {
      // Validate group exists — check Redis cache first, fallback to CDN fetch
      try {
        let cachedGroups = await redis('GET', 'cache:schedule-groups');
        if (cachedGroups) {
          const groups = JSON.parse(cachedGroups);
          if (!groups.includes(group)) {
            return res.status(400).json({ error: 'Такої групи не існує' });
          }
        } else {
          // Cold miss — fetch and cache for 5 minutes
          const baseUrl = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || 'mpmek.site'}`;
          const schedResp = await fetch(`${baseUrl}/schedule.json`);
          if (schedResp.ok) {
            const schedData = await schedResp.json();
            const groups = Object.keys(schedData).filter(k => k !== '_settings');
            // Fire and forget cache write
            redis('SET', 'cache:schedule-groups', JSON.stringify(groups), 'EX', 300).catch(() => {});
            if (!groups.includes(group)) {
              return res.status(400).json({ error: 'Такої групи не існує' });
            }
          }
        }
      } catch (e) {
        console.error('Group validation error:', e);
        return res.status(503).json({ error: 'Не вдалося перевірити групу. Спробуйте пізніше' });
      }
      } // end if (group)

      const user = await getUser(session.username);
      if (!user) return res.status(401).json({ error: 'Не авторизовано' });

      user.group = group;
      await redis('SET', `auth:user:${session.username}`, JSON.stringify(user));

      return res.json({ ok: true });
    }

    // ── Logout ──
    if (req.method === 'POST' && action === 'logout') {
      const session = await getSession(req);
      if (session) {
        await redis('DEL', `auth:session:${session.token}`);
      }
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('auth error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
