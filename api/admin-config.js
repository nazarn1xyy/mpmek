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
const {
  rateLimit, safeCompare, getSessionUsername,
  getAllUsers, getUser, createUser, updateUser, deleteUser,
  insertAuditLog, getAuditLog, getLoginLog, getCspReports,
  getBotUsers, upsertScheduleGroups
} = require('./_lib/db');
const { ADMIN_USERNAMES, STAROSTA_ACCOUNTS, TEACHER_ACCOUNTS } = require('./_lib/config');

const ADMIN_PIN = process.env.ADMIN_PIN;
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_OWNER = process.env.GITHUB_OWNER || 'nazarn1xyy';
const GH_REPO = process.env.GITHUB_REPO || 'mpmek';

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

  // Update schedule in Supabase so API endpoints serve fresh data immediately
  upsertScheduleGroups(schedule).catch(() => {});

  // 1b. Generate lightweight groups.json for fast group selection loading
  try {
    const groupNames = Object.keys(schedule).filter(k => k !== '_settings').sort();
    const groupsContent = JSON.stringify(groupNames);
    await ghPutWithRetry(
      'app/groups.json',
      () => groupsContent,
      '📋 Оновлено groups.json'
    );
  } catch (e) {
    console.warn('groups.json write skipped:', e.message);
  }

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

  // Audit log
  auditLog(req, 'publish', 'Schedule published').catch(() => {});
  return res.json({ ok: true });
}

async function auditLog(req, action, detail) {
  try {
    const uname = await getSessionUsername(req);
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
    await insertAuditLog({ username: uname || 'unknown', ip, action, detail });
  } catch (e) {
    console.warn('Audit log write failed:', e.message);
  }
}

async function handleUsers(res) {
  const dbUsers = await getAllUsers();
  const usersMap = {};
  for (const d of dbUsers) {
    usersMap[d.username] = {
      username: d.username,
      displayName: d.displayName || d.username,
      group: d.group || '',
      role: ADMIN_USERNAMES.includes(d.username) ? 'admin' : (d.role || 'user'),
      createdAt: d.createdAt || null,
      envStarosta: !!STAROSTA_ACCOUNTS[d.username],
      teacherName: d.teacherName || ''
    };
  }
  for (const [u, g] of Object.entries(STAROSTA_ACCOUNTS)) {
    if (!usersMap[u]) {
      usersMap[u] = { username: u, displayName: u, group: g, role: 'starosta', createdAt: null, envStarosta: true };
    } else if (usersMap[u].role !== 'admin') {
      usersMap[u].envStarosta = true;
      usersMap[u].role = 'starosta';
      usersMap[u].group = usersMap[u].group || g;
    }
  }
  for (const [u, teacherName] of Object.entries(TEACHER_ACCOUNTS)) {
    if (!usersMap[u]) {
      usersMap[u] = { username: u, displayName: teacherName, group: '', role: 'teacher', createdAt: null, envTeacher: true, teacherName };
    } else if (usersMap[u].role !== 'admin') {
      usersMap[u].envTeacher = true;
      usersMap[u].role = 'teacher';
      usersMap[u].teacherName = teacherName;
    }
  }
  const users = Object.values(usersMap);
  users.sort((a, b) => {
    const ro = { admin: 0, teacher: 1, starosta: 2, user: 3 };
    return (ro[a.role] ?? 4) - (ro[b.role] ?? 4) || a.username.localeCompare(b.username);
  });
  return res.json({ users, total: users.length });
}

async function handleSetRole(req, res) {
  const { username, role, group, teacherName } = req.body || {};
  const uname = (username || '').trim().toLowerCase();
  if (!uname) return res.status(400).json({ error: 'Username required' });
  if (!['user', 'starosta', 'teacher'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (ADMIN_USERNAMES.includes(uname)) return res.status(403).json({ error: 'Cannot modify admin' });
  const user = await getUser(uname);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const updates = { role };
  if (role === 'starosta') {
    if (group) updates.group = group;
    updates.teacherName = '';
  } else if (role === 'teacher') {
    if (teacherName) updates.teacherName = teacherName;
  } else {
    updates.teacherName = '';
  }
  await updateUser(uname, updates);
  auditLog(req, 'set-role', `${uname} → ${role}${group ? ' (' + group + ')' : ''}${teacherName ? ' [' + teacherName + ']' : ''}`).catch(() => {});
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
  if (pwd.length < 8) return res.status(400).json({ error: 'Пароль: мінімум 8 символів' });
  if (ADMIN_USERNAMES.includes(uname)) return res.status(403).json({ error: 'Логін зарезервовано' });
  const existing = await getUser(uname);
  if (existing) return res.status(409).json({ error: 'Користувач вже існує' });
  const salt = crypto.randomBytes(32).toString('hex');
  const hash = await pbkdf2(pwd, salt);
  const ok = await createUser(uname, { displayName: name || uname, passwordHash: hash, salt, group: grp, role: 'starosta' });
  if (!ok) return res.status(409).json({ error: 'Користувач вже існує' });
  auditLog(req, 'create-starosta', `${uname} (${grp})`).catch(() => {});
  return res.json({ ok: true, username: uname });
}

async function handleCreateTeacher(req, res) {
  const { username, password, displayName, teacherName } = req.body || {};
  const uname = (username || '').trim().toLowerCase();
  const pwd = password || '';
  const name = (displayName || '').trim();
  const tName = (teacherName || '').trim();
  if (!uname || !pwd || !tName) return res.status(400).json({ error: 'Логін, пароль і ім\'я вчителя (як в розкладі) обов\'язкові' });
  if (uname.length < 3 || !/^[a-z0-9_]+$/.test(uname)) return res.status(400).json({ error: 'Логін: від 3 символів, латиниця/цифри/_' });
  if (pwd.length < 8) return res.status(400).json({ error: 'Пароль: мінімум 8 символів' });
  if (ADMIN_USERNAMES.includes(uname)) return res.status(403).json({ error: 'Логін зарезервовано' });
  const existing = await getUser(uname);
  if (existing) return res.status(409).json({ error: 'Користувач вже існує' });
  const salt = crypto.randomBytes(32).toString('hex');
  const hash = await pbkdf2(pwd, salt);
  const ok = await createUser(uname, { displayName: name || tName, passwordHash: hash, salt, group: '', role: 'teacher', teacherName: tName });
  if (!ok) return res.status(409).json({ error: 'Користувач вже існує' });
  auditLog(req, 'create-teacher', `${uname} (${tName})`).catch(() => {});
  return res.json({ ok: true, username: uname });
}

// Transliteration table for Ukrainian teacher name → latin login
const TRANSLIT = {
  'а':'a','б':'b','в':'v','г':'h','ґ':'g','д':'d','е':'e','є':'ie','ж':'zh',
  'з':'z','и':'y','і':'i','ї':'i','й':'j','к':'k','л':'l','м':'m','н':'n',
  'о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts',
  'ч':'ch','ш':'sh','щ':'shch','ь':'','ю':'iu','я':'ia'
};
function translitName(str) {
  return str.toLowerCase().split('').map(c => TRANSLIT[c] ?? (c.match(/[a-z0-9]/) ? c : '')).join('');
}
function generateLogin(teacherName) {
  // "Сабірова О.В." → surname="Сабірова", initial="О" → "sabirova_o"
  const parts = teacherName.trim().split(/\s+/);
  const surname = translitName(parts[0] || '');
  const initial = parts[1] ? translitName(parts[1].replace(/\./g, '').slice(0, 1)) : '';
  const base = (surname + (initial ? '_' + initial : '')).replace(/[^a-z0-9_]/g, '').slice(0, 28);
  return base || 'teacher';
}
function generatePassword() {
  const digits = crypto.randomInt(1000, 9999);
  const words = ['Mpmek','Shkola','Teach','Klass','Rozklad'];
  return words[crypto.randomInt(words.length)] + digits;
}

async function handleImportTeachers(req, res) {
  // Fetch schedule to extract unique teacher names
  const baseUrl = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || 'mpmek.site'}`;
  let schedule;
  try {
    const r = await fetch(`${baseUrl}/schedule.json`);
    if (!r.ok) throw new Error('schedule fetch failed');
    schedule = await r.json();
  } catch (e) {
    return res.status(503).json({ error: 'Не вдалося завантажити розклад: ' + e.message });
  }

  // Collect unique non-empty teacher names
  const teacherSet = new Set();
  for (const groupData of Object.values(schedule)) {
    for (const [weekType, weekData] of Object.entries(groupData)) {
      if (weekType === 'ПІДВІСКА' || !weekData || typeof weekData !== 'object') continue;
      for (const dayPairs of Object.values(weekData)) {
        if (!Array.isArray(dayPairs)) continue;
        for (const pair of dayPairs) {
          if (pair.teacher && pair.teacher.trim()) teacherSet.add(pair.teacher.trim());
        }
      }
    }
  }

  const results = [];
  let skipped = 0;
  for (const teacherName of [...teacherSet].sort()) {
    const baseLogin = generateLogin(teacherName);
    // Ensure unique login (append number if taken)
    let login = baseLogin;
    let attempt = 0;
    let existingUser = await getUser(login);
    // Skip if account with same teacherName already exists
    if (existingUser) {
      if (existingUser.teacherName === teacherName) { skipped++; continue; }
    }
    while (existingUser) {
      attempt++;
      login = baseLogin + attempt;
      existingUser = await getUser(login);
      if (existingUser && existingUser.teacherName === teacherName) { skipped++; login = null; break; }
    }
    if (!login) continue;

    const password = generatePassword();
    const salt = crypto.randomBytes(32).toString('hex');
    const hash = await pbkdf2(password, salt);
    await createUser(login, { displayName: teacherName, passwordHash: hash, salt, group: '', role: 'teacher', teacherName });
    results.push({ login, password, teacherName });
  }

  auditLog(req, 'import-teachers', `Imported ${results.length}, skipped ${skipped} teachers`).catch(() => {});
  return res.json({ ok: true, created: results.length, skipped, teachers: results });
}

async function handleDeleteUser(req, res) {
  const { username } = req.body || {};
  const uname = (username || '').trim().toLowerCase();
  if (!uname) return res.status(400).json({ error: 'Username required' });
  if (ADMIN_USERNAMES.includes(uname)) return res.status(403).json({ error: 'Cannot delete admin' });
  await deleteUser(uname); // cascades sessions, webauthn, push subs via FK
  auditLog(req, 'delete-user', uname).catch(() => {});
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

  // Per-account (session-tied) lockout via Supabase rate limiter
  const bearerToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').slice(0, 128);
  if (bearerToken) {
    if (await rateLimit(`admin:pin:${bearerToken.slice(0, 16)}`, 20, 900)) {
      return res.status(429).json({ error: 'Акаунт заблоковано на 15 хв через забагато невдалих спроб' });
    }
  }

  const pin = req.headers['x-admin-pin'];
  if (!safeCompare(pin, ADMIN_PIN)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!(await hasAdminSession(req))) {
    return res.status(403).json({ error: 'Admin session required' });
  }

  try {
    const action = req.query.action;

    if (req.method === 'POST' && action === 'publish') return await handlePublish(req, res);
    if (req.method === 'GET' && action === 'users') return await handleUsers(res);
    if (req.method === 'GET' && action === 'bot-users') {
      const users = await getBotUsers();
      users.sort((a, b) => (a.group || '').localeCompare(b.group || '') || (a.name || '').localeCompare(b.name || ''));
      return res.json({ users, total: users.length, syncedAt: users[0]?.syncedAt || null });
    }
    if (req.method === 'POST' && action === 'set-role') return await handleSetRole(req, res);
    if (req.method === 'POST' && action === 'create-starosta') return await handleCreateStarosta(req, res);
    if (req.method === 'POST' && action === 'create-teacher') return await handleCreateTeacher(req, res);
    if (req.method === 'POST' && action === 'import-teachers') return await handleImportTeachers(req, res);
    if (req.method === 'POST' && action === 'delete-user') return await handleDeleteUser(req, res);
    if (req.method === 'GET' && action === 'audit-log') {
      const entries = await getAuditLog(100);
      return res.json({ entries, total: entries.length });
    }
    if (req.method === 'GET' && action === 'login-log') {
      const entries = await getLoginLog(100);
      return res.json({ entries, total: entries.length });
    }
    if (req.method === 'GET' && action === 'csp-reports') {
      const entries = await getCspReports(100);
      return res.json({ entries, total: entries.length });
    }
    if (req.method === 'GET' && !action) return res.status(200).json({ ok: true });

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('admin-config error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
