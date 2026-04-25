const crypto = require('crypto');
const { redis, rateLimit, safeKey, safeCompare } = require('./_lib/redis');

const SESSION_TTL = 30 * 24 * 60 * 60; // 30 days

// WebAuthn (Face ID / Touch ID)
const RP_ID = process.env.WEBAUTHN_RP_ID || 'mpmek.site';
const RP_NAME = 'МПМЕК Адмін';
const RP_ORIGIN = process.env.WEBAUTHN_ORIGIN || `https://${RP_ID}`;

let _webauthn = null;
async function webauthn() {
  if (!_webauthn) _webauthn = await import('@simplewebauthn/server');
  return _webauthn;
}

// Admin usernames from env (comma-separated), e.g. "nazar,admin2"
const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// Starosta accounts from env (format: "username:group,username:group,...")
const STAROSTA_ACCOUNTS = {};
(process.env.STAROSTA_ACCOUNTS || '').split(',').map(s => s.trim()).filter(Boolean).forEach(entry => {
  const sep = entry.indexOf(':');
  if (sep > 0) {
    const username = entry.slice(0, sep).trim().toLowerCase();
    const group = entry.slice(sep + 1).trim();
    if (username && group) STAROSTA_ACCOUNTS[username] = group;
  }
});

function getUserRole(username, userData) {
  if (ADMIN_USERNAMES.includes(username)) return 'admin';
  if (STAROSTA_ACCOUNTS[username]) return 'starosta';
  if (userData && userData.role === 'starosta') return 'starosta';
  return 'user';
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

    // ── VAPID public key (no auth required) ──
    if (req.method === 'GET' && action === 'vapid-key') {
      const key = process.env.VAPID_PUBLIC_KEY;
      if (!key) return res.status(500).json({ error: 'VAPID key not configured' });
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.json({ publicKey: key });
    }

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

      // Block admin and starosta usernames from normal registration
      if (ADMIN_USERNAMES.includes(username) || STAROSTA_ACCOUNTS[username]) {
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
      }

      // Starosta login: password = username + "123"
      if (STAROSTA_ACCOUNTS[username]) {
        const expectedPwd = username + '123';
        if (!safeCompare(password, expectedPwd)) {
          return res.status(401).json({ error: 'Невірний логін або пароль' });
        }

        const starostaGroup = STAROSTA_ACCOUNTS[username];
        if (!user) {
          user = { displayName: username, group: starostaGroup, role: 'starosta', createdAt: new Date().toISOString() };
          await redis('SET', `auth:user:${username}`, JSON.stringify(user));
        } else if (user.group !== starostaGroup || user.role !== 'starosta') {
          user.group = starostaGroup;
          user.role = 'starosta';
          await redis('SET', `auth:user:${username}`, JSON.stringify(user));
        }

        const sessionVer = crypto.randomBytes(4).toString('hex');
        await redis('SET', `auth:sver:${username}`, sessionVer, 'EX', SESSION_TTL);
        const token = crypto.randomBytes(32).toString('hex');
        await redis('SET', `auth:session:${token}`, `${username}:${sessionVer}`);
        await redis('EXPIRE', `auth:session:${token}`, SESSION_TTL);

        return res.json({
          token,
          user: { username, displayName: user.displayName, group: starostaGroup, role: 'starosta' }
        });
      }

      // Normal user login
      {
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
        user: { username, displayName: user.displayName, group: user.group || '', role: getUserRole(username, user) }
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
          role: getUserRole(session.username, user)
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

    // ── WebAuthn: check if user has credential ──
    if (req.method === 'GET' && action === 'webauthn-check') {
      const session = await getSession(req);
      if (!session) return res.status(401).json({ error: 'Не авторизовано' });
      const raw = await redis('GET', `webauthn:creds:${session.username}`);
      const creds = raw ? JSON.parse(raw) : [];
      return res.json({ registered: creds.length > 0 });
    }

    // ── WebAuthn: registration options ──
    if (req.method === 'POST' && action === 'webauthn-register-options') {
      const session = await getSession(req);
      if (!session) return res.status(401).json({ error: 'Не авторизовано' });
      const wa = await webauthn();
      const raw = await redis('GET', `webauthn:creds:${session.username}`);
      const existing = raw ? JSON.parse(raw) : [];
      const options = await wa.generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: RP_ID,
        userName: session.username,
        userDisplayName: session.username,
        attestationType: 'none',
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'preferred',
        },
        excludeCredentials: existing.map(c => ({ id: c.credentialID })),
      });
      await redis('SET', `webauthn:challenge:${session.username}`, options.challenge, 'EX', 300);
      return res.json(options);
    }

    // ── WebAuthn: verify registration ──
    if (req.method === 'POST' && action === 'webauthn-register') {
      const session = await getSession(req);
      if (!session) return res.status(401).json({ error: 'Не авторизовано' });
      const wa = await webauthn();
      const expectedChallenge = await redis('GET', `webauthn:challenge:${session.username}`);
      if (!expectedChallenge) return res.status(400).json({ error: 'Challenge expired' });
      await redis('DEL', `webauthn:challenge:${session.username}`);
      try {
        const verification = await wa.verifyRegistrationResponse({
          response: req.body,
          expectedChallenge,
          expectedOrigin: RP_ORIGIN,
          expectedRPID: RP_ID,
        });
        if (!verification.verified || !verification.registrationInfo) {
          return res.status(400).json({ error: 'Verification failed' });
        }
        const { credential } = verification.registrationInfo;
        const raw = await redis('GET', `webauthn:creds:${session.username}`);
        const creds = raw ? JSON.parse(raw) : [];
        creds.push({
          credentialID: credential.id,
          publicKey: Buffer.from(credential.publicKey).toString('base64'),
          counter: credential.counter,
          createdAt: new Date().toISOString(),
        });
        await redis('SET', `webauthn:creds:${session.username}`, JSON.stringify(creds));
        return res.json({ ok: true });
      } catch (e) {
        console.error('WebAuthn register error:', e);
        return res.status(400).json({ error: 'Verification failed' });
      }
    }

    // ── WebAuthn: authentication options ──
    if (req.method === 'POST' && action === 'webauthn-auth-options') {
      const session = await getSession(req);
      if (!session) return res.status(401).json({ error: 'Не авторизовано' });
      const wa = await webauthn();
      const raw = await redis('GET', `webauthn:creds:${session.username}`);
      const creds = raw ? JSON.parse(raw) : [];
      if (creds.length === 0) return res.status(404).json({ error: 'No credentials' });
      const options = await wa.generateAuthenticationOptions({
        rpID: RP_ID,
        userVerification: 'required',
        allowCredentials: creds.map(c => ({ id: c.credentialID })),
      });
      await redis('SET', `webauthn:challenge:${session.username}`, options.challenge, 'EX', 300);
      return res.json(options);
    }

    // ── WebAuthn: verify authentication ──
    if (req.method === 'POST' && action === 'webauthn-auth') {
      const session = await getSession(req);
      if (!session) return res.status(401).json({ error: 'Не авторизовано' });
      const wa = await webauthn();
      const expectedChallenge = await redis('GET', `webauthn:challenge:${session.username}`);
      if (!expectedChallenge) return res.status(400).json({ error: 'Challenge expired' });
      await redis('DEL', `webauthn:challenge:${session.username}`);
      const raw = await redis('GET', `webauthn:creds:${session.username}`);
      const creds = raw ? JSON.parse(raw) : [];
      const cred = creds.find(c => c.credentialID === req.body.id);
      if (!cred) return res.status(400).json({ error: 'Unknown credential' });
      try {
        const verification = await wa.verifyAuthenticationResponse({
          response: req.body,
          expectedChallenge,
          expectedOrigin: RP_ORIGIN,
          expectedRPID: RP_ID,
          credential: {
            id: cred.credentialID,
            publicKey: new Uint8Array(Buffer.from(cred.publicKey, 'base64')),
            counter: cred.counter,
          },
        });
        if (!verification.verified) {
          return res.status(400).json({ error: 'Verification failed' });
        }
        // Update counter
        cred.counter = verification.authenticationInfo.newCounter;
        await redis('SET', `webauthn:creds:${session.username}`, JSON.stringify(creds));
        return res.json({ ok: true, verified: true });
      } catch (e) {
        console.error('WebAuthn auth error:', e);
        return res.status(400).json({ error: 'Verification failed' });
      }
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('auth error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
