const crypto = require('crypto');
const { redis } = require('./_lib/redis');

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
}

function generateToken(username) {
  const payload = `${username}:${Date.now()}:${crypto.randomBytes(16).toString('hex')}`;
  return Buffer.from(payload).toString('base64');
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin;
  if (origin && (origin === 'https://mpmek.site' || origin.endsWith('.vercel.app') || origin.includes('localhost'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'https://mpmek.site');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || (req.body && req.body.action);

  // Handle local dev when Redis is not available
  const hasRedis = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

  try {
    // 1. REGISTER
    if (action === 'register') {
      const { username, password, name, group, initialData } = req.body || {};

      if (!username || !password) {
        return res.status(400).json({ error: 'Логін та пароль є обовʼязковими' });
      }

      const cleanUsername = username.trim().toLowerCase();
      if (cleanUsername.length < 3) {
        return res.status(400).json({ error: 'Логін має містити щонайменше 3 символи' });
      }
      if (password.length < 4) {
        return res.status(400).json({ error: 'Пароль має містити щонайменше 4 символи' });
      }

      const token = generateToken(cleanUsername);
      const userProfile = {
        username: cleanUsername,
        name: (name || cleanUsername).trim(),
        group: group || '',
        createdAt: Date.now()
      };

      if (hasRedis) {
        // Check if user exists
        try {
          const existing = await redis('GET', `user:${cleanUsername}`);
          if (existing) {
            return res.status(400).json({ error: 'Користувач із таким логіном уже існує' });
          }
        } catch (e) {
          console.warn('Redis check user error:', e);
        }

        const salt = crypto.randomBytes(16).toString('hex');
        const passHash = hashPassword(password, salt);

        const userData = {
          ...userProfile,
          salt,
          passHash,
          token
        };

        await redis('SET', `user:${cleanUsername}`, JSON.stringify(userData));
        if (initialData && initialData.homework) {
          await redis('SET', `user_hw:${cleanUsername}`, JSON.stringify(initialData.homework));
        }
        if (initialData && initialData.settings) {
          await redis('SET', `user_settings:${cleanUsername}`, JSON.stringify(initialData.settings));
        }
      }

      return res.json({
        ok: true,
        token,
        user: userProfile,
        homework: (initialData && initialData.homework) || {},
        settings: (initialData && initialData.settings) || {}
      });
    }

    // 2. LOGIN
    if (action === 'login') {
      const { username, password } = req.body || {};
      if (!username || !password) {
        return res.status(400).json({ error: 'Введіть логін та пароль' });
      }

      const cleanUsername = username.trim().toLowerCase();

      if (!hasRedis) {
        // Local dev mock login
        const token = generateToken(cleanUsername);
        return res.json({
          ok: true,
          token,
          user: { username: cleanUsername, name: cleanUsername, group: '', createdAt: Date.now() },
          homework: {},
          settings: {}
        });
      }

      const rawUser = await redis('GET', `user:${cleanUsername}`);
      if (!rawUser) {
        return res.status(400).json({ error: 'Невірний логін або пароль' });
      }

      const userData = JSON.parse(rawUser);
      const computedHash = hashPassword(password, userData.salt);

      if (computedHash !== userData.passHash) {
        return res.status(400).json({ error: 'Невірний логін або пароль' });
      }

      const token = generateToken(cleanUsername);
      userData.token = token;
      await redis('SET', `user:${cleanUsername}`, JSON.stringify(userData));

      let homework = {};
      let settings = {};
      try {
        const rawHw = await redis('GET', `user_hw:${cleanUsername}`);
        if (rawHw) homework = JSON.parse(rawHw);
      } catch {}

      try {
        const rawSettings = await redis('GET', `user_settings:${cleanUsername}`);
        if (rawSettings) settings = JSON.parse(rawSettings);
      } catch {}

      return res.json({
        ok: true,
        token,
        user: {
          username: userData.username,
          name: userData.name,
          group: userData.group,
          createdAt: userData.createdAt
        },
        homework,
        settings
      });
    }

    // 3. SYNC
    if (action === 'sync') {
      const { username, homework, settings, group } = req.body || {};
      if (!username) {
        return res.status(400).json({ error: 'username is required' });
      }

      const cleanUsername = username.trim().toLowerCase();

      if (hasRedis) {
        if (homework !== undefined) {
          await redis('SET', `user_hw:${cleanUsername}`, JSON.stringify(homework));
        }
        if (settings !== undefined) {
          await redis('SET', `user_settings:${cleanUsername}`, JSON.stringify(settings));
        }
        if (group) {
          try {
            const rawUser = await redis('GET', `user:${cleanUsername}`);
            if (rawUser) {
              const userData = JSON.parse(rawUser);
              userData.group = group;
              await redis('SET', `user:${cleanUsername}`, JSON.stringify(userData));
            }
          } catch {}
        }
      }

      return res.json({ ok: true, syncedAt: Date.now() });
    }

    // 4. ME
    if (action === 'me') {
      const authHeader = req.headers.authorization || '';
      const token = authHeader.replace('Bearer ', '').trim();
      const username = req.query.username;

      if (!username) {
        return res.status(400).json({ error: 'username required' });
      }

      return res.json({
        ok: true,
        user: { username, name: username, group: '' }
      });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    console.error('Auth API Error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
