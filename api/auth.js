const crypto = require('crypto');
const { redis, rateLimit, safeKey } = require('./_lib/redis');

const SESSION_TTL = 30 * 24 * 60 * 60; // 30 days

// Admin usernames from env (comma-separated), e.g. "nazar,admin2"
const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const MAX_ADMIN_DEVICES = 2;

function getUserRole(username) {
  return ADMIN_USERNAMES.includes(username) ? 'admin' : 'user';
}

function pbkdf2(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, 100000, 64, 'sha512', (err, key) => {
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
  const uname = await redis('GET', `auth:session:${token}`);
  if (!uname) return null;
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
      if (password.length < 6 || password.length > 128) {
        return res.status(400).json({ error: 'Пароль: від 6 до 128 символів' });
      }
      if (displayName.length < 2) {
        return res.status(400).json({ error: 'Ім\'я: мінімум 2 символи' });
      }

      // Block admin usernames from normal registration
      if (ADMIN_USERNAMES.includes(username)) {
        return res.status(403).json({ error: 'Цей логін зарезервовано' });
      }

      // Check uniqueness
      const existing = await redis('GET', `auth:user:${username}`);
      if (existing) {
        return res.status(409).json({ error: 'Цей логін вже зайнятий' });
      }

      // Hash password
      const salt = crypto.randomBytes(32).toString('hex');
      const hash = await pbkdf2(password, salt);

      // Store user
      const userData = {
        displayName,
        passwordHash: hash,
        salt,
        group: '',
        createdAt: new Date().toISOString()
      };
      await redis('SET', `auth:user:${username}`, JSON.stringify(userData));

      // Create session
      const token = crypto.randomBytes(32).toString('hex');
      await redis('SET', `auth:session:${token}`, username);
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

      // Admin login: verify against env password, auto-create account if needed
      if (ADMIN_USERNAMES.includes(username)) {
        const envPwd = process.env.ADMIN_PASSWORD;
        if (!envPwd || password !== envPwd) {
          return res.status(401).json({ error: 'Невірний логін або пароль' });
        }

        // Device restriction: max N trusted devices
        let deviceId = req.body.deviceId;
        const devKey = `auth:admin-devices:${username}`;
        const devices = await redis('SMEMBERS', devKey) || [];
        if (deviceId && devices.includes(deviceId)) {
          // Known device — OK
        } else if (devices.length >= MAX_ADMIN_DEVICES) {
          return res.status(403).json({ error: 'Ліміт пристроїв адміна вичерпано (' + MAX_ADMIN_DEVICES + ')' });
        } else {
          // New device — register it
          deviceId = crypto.randomBytes(16).toString('hex');
          await redis('SADD', devKey, deviceId);
        }

        // Auto-create admin account on first login
        if (!user) {
          const salt = crypto.randomBytes(32).toString('hex');
          const pwHash = await pbkdf2(password, salt);
          user = { displayName: 'Адміністратор', passwordHash: pwHash, salt, group: '', createdAt: new Date().toISOString() };
          await redis('SET', `auth:user:${username}`, JSON.stringify(user));
        }

        // Return deviceId to client to store
        const token = crypto.randomBytes(32).toString('hex');
        await redis('SET', `auth:session:${token}`, username);
        await redis('EXPIRE', `auth:session:${token}`, SESSION_TTL);

        return res.json({
          token, deviceId,
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

      // Create session
      const token = crypto.randomBytes(32).toString('hex');
      await redis('SET', `auth:session:${token}`, username);
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

      const group = sanitize(req.body.group, 50);
      if (!group) return res.status(400).json({ error: 'Невірна група' });

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
