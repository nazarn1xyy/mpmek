/**
 * Admin endpoints combined (Vercel Hobby plan limit: 12 serverless functions).
 *
 * Routes:
 *   GET  /api/admin-config                   → verify admin credentials (auth probe)
 *   POST /api/admin-config?action=publish    → push schedule.json to GitHub via server token
 *
 * Auth (for every route): X-Admin-Pin header + Authorization: Bearer <admin session token>
 */
const { redis, rateLimit, safeCompare } = require('./_lib/redis');

const ADMIN_PIN = process.env.ADMIN_PIN;
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_OWNER = process.env.GITHUB_OWNER || 'nazarn1xyy';
const GH_REPO = process.env.GITHUB_REPO || 'mpmek';
const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

async function hasAdminSession(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  if (!token || token.length > 128) return false;
  const uname = await redis('GET', `auth:session:${token}`);
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
    throw new Error(`GitHub put ${filePath}: ${err.message || resp.status}`);
  }
  return resp.json();
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

  // 1. Push schedule.json
  const scheduleInfo = await ghFetch('app/schedule.json');
  const newContent = JSON.stringify(schedule, null, 2);
  await ghPut('app/schedule.json', newContent, scheduleInfo.sha,
    '📅 Оновлено розклад через адмін-панель');

  // 2. Bump SW cache version so clients fetch fresh assets
  try {
    const swInfo = await ghFetch('app/sw.js');
    let swContent = Buffer.from(swInfo.content, 'base64').toString('utf-8');
    const match = swContent.match(/rozklad-v(\d+)/);
    if (match) {
      const newVer = parseInt(match[1]) + 1;
      swContent = swContent.replace(/rozklad-v\d+/, `rozklad-v${newVer}`);
      await ghPut('app/sw.js', swContent, swInfo.sha,
        `🔄 Бамп версії кешу SW (v${newVer})`);
    }
  } catch (e) {
    console.warn('SW bump skipped:', e.message);
  }

  return res.json({ ok: true });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://mpmek.site');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Pin, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Rate limit PIN attempts (anti brute-force) — per IP and globally
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (await rateLimit(`admin:${ip}`, 10, 300)) {
    return res.status(429).json({ error: 'Too many attempts. Wait 5 minutes' });
  }
  if (await rateLimit('admin:global', 100, 300)) {
    return res.status(429).json({ error: 'Забагато спроб. Зачекайте' });
  }

  // Require PIN + admin session for EVERY route
  if (!ADMIN_PIN) {
    return res.status(500).json({ error: 'ADMIN_PIN not configured' });
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

    // POST with action=publish → push schedule.json to GitHub
    if (req.method === 'POST' && action === 'publish') {
      return await handlePublish(req, res);
    }

    // GET → auth probe (returns ok if credentials are valid)
    if (req.method === 'GET') {
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('admin-config error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
};
