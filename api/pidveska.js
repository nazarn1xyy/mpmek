/**
 * API for managing підвіска (substitutions) in schedule.json via GitHub API.
 * POST: add підвіска entries
 * DELETE: remove a підвіска entry
 * Auth: bot_token must match TELEGRAM_BOT_TOKEN env var
 */
const { safeCompare, getSessionUsername, redis } = require('./_lib/redis');

const DATE_RE = /^\d{2}\.\d{2}$/;

const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const STAROSTA_ACCOUNTS = {};
(process.env.STAROSTA_ACCOUNTS || '').split(',').map(s => s.trim()).filter(Boolean).forEach(entry => {
  const sep = entry.indexOf(':');
  if (sep > 0) {
    const username = entry.slice(0, sep).trim().toLowerCase();
    const group = entry.slice(sep + 1).trim();
    if (username && group) STAROSTA_ACCOUNTS[username] = group;
  }
});

// Authenticate via Bearer token — returns { username, group, role } or null
async function authenticateBearer(req) {
  const uname = await getSessionUsername(req);
  if (!uname) return null;
  if (ADMIN_USERNAMES.includes(uname)) return { username: uname, group: null, role: 'admin' };
  if (STAROSTA_ACCOUNTS[uname]) return { username: uname, group: STAROSTA_ACCOUNTS[uname], role: 'starosta' };
  // Check stored user role
  const raw = await redis('GET', `auth:user:${uname}`);
  if (raw) {
    try {
      const user = JSON.parse(raw);
      if (user.role === 'starosta') return { username: uname, group: user.group, role: 'starosta' };
    } catch {}
  }
  return null; // normal users cannot use this API
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://mpmek.site');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const GH_TOKEN = process.env.GITHUB_TOKEN;
  const GH_OWNER = process.env.GITHUB_OWNER || 'nazarn1xyy';
  const GH_REPO = process.env.GITHUB_REPO || 'mpmek';

  if (!GH_TOKEN) {
    return res.status(500).json({ error: 'Missing env var (GITHUB_TOKEN)' });
  }

  // Auth: bot_token (Telegram bot) OR Bearer token (starosta/admin)
  const { bot_token } = req.body || {};
  let authUser = null;
  if (bot_token && BOT_TOKEN && safeCompare(bot_token, BOT_TOKEN)) {
    authUser = { username: 'bot', group: null, role: 'admin' };
  } else {
    authUser = await authenticateBearer(req);
  }
  if (!authUser) {
    return res.status(403).json({ error: 'unauthorized' });
  }

  const ghHeaders = {
    'Authorization': `token ${GH_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'mpmek-bot',
  };

  try {
    if (req.method === 'POST') {
      return await handleAdd(req, res, ghHeaders, GH_OWNER, GH_REPO, authUser);
    } else if (req.method === 'DELETE') {
      return await handleDelete(req, res, ghHeaders, GH_OWNER, GH_REPO, authUser);
    } else {
      return res.status(405).json({ error: 'method not allowed' });
    }
  } catch (err) {
    console.error('pidveska API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ===== GitHub helpers with retry on 409/422 (concurrent write conflict) =====
async function ghGet(owner, repo, filePath, headers) {
  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
    { headers }
  );
  if (!resp.ok) {
    const e = new Error(`GitHub fetch ${filePath}: ${resp.status}`);
    e.status = resp.status;
    throw e;
  }
  return resp.json();
}

async function ghPut(owner, repo, filePath, content, sha, message, headers) {
  const encoded = Buffer.from(content, 'utf-8').toString('base64');
  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
    {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, content: encoded, sha }),
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

// Retry loop — re-fetches latest SHA on 409/422 so we merge against the newest version.
async function ghModifyWithRetry(owner, repo, filePath, transform, message, headers, maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const info = await ghGet(owner, repo, filePath, headers);
      const currentContent = Buffer.from(info.content, 'base64').toString('utf-8');
      const result = await transform(currentContent);
      if (result === null || result === undefined) return null; // abort (no changes)
      const { newContent, meta } = typeof result === 'string'
        ? { newContent: result, meta: null }
        : result;
      await ghPut(owner, repo, filePath, newContent, info.sha, message, headers);
      return meta;
    } catch (e) {
      lastErr = e;
      if (e.status !== 409 && e.status !== 422) throw e;
      // Exponential backoff: 250ms, 500ms, 1000ms, 2000ms
      await new Promise(r => setTimeout(r, 250 * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
}

// Bump SW cache version (best-effort, not fatal if fails)
async function bumpSwVersion(owner, repo, headers) {
  try {
    await ghModifyWithRetry(
      owner, repo, 'app/sw.js',
      (currentSw) => {
        const match = currentSw.match(/rozklad-v(\d+)/);
        if (!match) return null;
        const newVer = parseInt(match[1], 10) + 1;
        return currentSw.replace(/rozklad-v\d+/, `rozklad-v${newVer}`);
      },
      '🔄 Бамп версії кешу SW (pidveska)',
      headers
    );
  } catch (e) {
    console.warn('SW bump skipped:', e.message);
  }
}

function sanitizeEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const date = typeof e.date === 'string' ? e.date.trim() : '';
  if (!DATE_RE.test(date)) return null;
  const number = Number(e.number);
  if (!Number.isFinite(number) || number < 1 || number > 8) return null;
  const subject = typeof e.subject === 'string' ? e.subject.trim().slice(0, 200) : '';
  const teacher = typeof e.teacher === 'string' ? e.teacher.trim().slice(0, 100) : '';
  return { date, number, subject, teacher };
}

async function handleAdd(req, res, ghHeaders, owner, repo, authUser) {
  const { group, entries } = req.body || {};
  if (!group || typeof group !== 'string' || group.length > 80) {
    return res.status(400).json({ error: 'group required (max 80 chars)' });
  }
  // Starostas can only modify their own group
  if (authUser && authUser.role === 'starosta' && authUser.group !== group) {
    return res.status(403).json({ error: 'Можна редагувати тільки свою групу' });
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'entries[] required' });
  }
  if (entries.length > 50) {
    return res.status(400).json({ error: 'Max 50 entries per request' });
  }

  // Validate early so we fail before any GitHub calls
  const sanitized = entries.map(sanitizeEntry);
  const validEntries = sanitized.filter(Boolean);
  const rejected = sanitized.length - validEntries.length;
  if (validEntries.length === 0) {
    return res.status(400).json({ error: `All ${rejected} entries had invalid format` });
  }

  let lastAdded = 0;
  const meta = await ghModifyWithRetry(
    owner, repo, 'app/schedule.json',
    (content) => {
      const scheduleData = JSON.parse(content);
      if (!scheduleData[group]) {
        throw Object.assign(new Error(`Group "${group}" not found`), { status: 404 });
      }
      if (!scheduleData[group]['ПІДВІСКА']) {
        scheduleData[group]['ПІДВІСКА'] = [];
      }
      // Cap total підвіска entries per group to prevent schedule.json bloat
      if (scheduleData[group]['ПІДВІСКА'].length >= 200) {
        throw Object.assign(new Error('Too many підвіска entries (max 200)'), { status: 400 });
      }
      const existing = new Set(
        scheduleData[group]['ПІДВІСКА'].map(e => `${e.date}|${e.number}`)
      );
      let added = 0;
      for (const e of validEntries) {
        const key = `${e.date}|${e.number}`;
        if (!existing.has(key)) {
          scheduleData[group]['ПІДВІСКА'].push(e);
          existing.add(key);
          added++;
        }
      }
      if (added === 0) return null;
      lastAdded = added;
      return { newContent: JSON.stringify(scheduleData), meta: { added } };
    },
    `📌 Підвіска (${group}): +${validEntries.length} через бот`,
    ghHeaders
  );
  // Note: commit message uses validEntries.length; actual added count returned separately.
  void lastAdded;

  if (!meta) {
    return res.json({ ok: true, added: 0, message: 'All entries already exist' });
  }

  // Bump SW cache so clients see new підвіска immediately
  await bumpSwVersion(owner, repo, ghHeaders);

  return res.json({ ok: true, added: meta.added });
}

async function handleDelete(req, res, ghHeaders, owner, repo, authUser) {
  const { group, date, number } = req.body || {};
  if (!group || typeof group !== 'string' || group.length > 80) {
    return res.status(400).json({ error: 'group required' });
  }
  // Starostas can only modify their own group
  if (authUser && authUser.role === 'starosta' && authUser.group !== group) {
    return res.status(403).json({ error: 'Можна редагувати тільки свою групу' });
  }
  if (typeof date !== 'string' || !DATE_RE.test(date)) {
    return res.status(400).json({ error: 'date must be DD.MM' });
  }
  const para = Number(number);
  if (!Number.isFinite(para) || para < 1 || para > 8) {
    return res.status(400).json({ error: 'invalid number' });
  }

  const meta = await ghModifyWithRetry(
    owner, repo, 'app/schedule.json',
    (content) => {
      const scheduleData = JSON.parse(content);
      if (!scheduleData[group] || !scheduleData[group]['ПІДВІСКА']) return null;
      const before = scheduleData[group]['ПІДВІСКА'].length;
      scheduleData[group]['ПІДВІСКА'] = scheduleData[group]['ПІДВІСКА'].filter(
        e => !(e.date === date && e.number === para)
      );
      const removed = before - scheduleData[group]['ПІДВІСКА'].length;
      if (removed === 0) return null;
      return { newContent: JSON.stringify(scheduleData), meta: { removed } };
    },
    `🗑 Підвіска видалена (${group}): ${date} пара ${para}`,
    ghHeaders
  );

  if (!meta) return res.json({ ok: true, removed: 0 });

  await bumpSwVersion(owner, repo, ghHeaders);

  return res.json({ ok: true, removed: meta.removed });
}
