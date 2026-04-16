/**
 * API for managing підвіска (substitutions) in schedule.json via GitHub API.
 * POST: add підвіска entries
 * DELETE: remove a підвіска entry
 * Auth: bot_token must match TELEGRAM_BOT_TOKEN env var
 */
const { safeCompare } = require('./_lib/redis');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://mpmek.site');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const GH_TOKEN = process.env.GITHUB_TOKEN;
  const GH_OWNER = process.env.GITHUB_OWNER || 'nazarn1xyy';
  const GH_REPO = process.env.GITHUB_REPO || 'mpmek';

  if (!BOT_TOKEN || !GH_TOKEN) {
    return res.status(500).json({ error: 'Missing env vars (TELEGRAM_BOT_TOKEN or GITHUB_TOKEN)' });
  }

  // Auth check
  const { bot_token } = req.body || {};
  if (!safeCompare(bot_token, BOT_TOKEN)) {
    return res.status(403).json({ error: 'unauthorized' });
  }

  try {
    // 1. Fetch current schedule.json from GitHub
    const filePath = 'app/schedule.json';
    const ghHeaders = {
      'Authorization': `token ${GH_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'mpmek-bot',
    };

    const getResp = await fetch(
      `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${filePath}`,
      { headers: ghHeaders }
    );
    if (!getResp.ok) {
      const err = await getResp.text();
      return res.status(502).json({ error: 'GitHub fetch failed', details: err });
    }
    const fileInfo = await getResp.json();
    const content = Buffer.from(fileInfo.content, 'base64').toString('utf-8');
    const scheduleData = JSON.parse(content);

    if (req.method === 'POST') {
      return await handleAdd(req, res, scheduleData, fileInfo.sha, filePath, ghHeaders, GH_OWNER, GH_REPO);
    } else if (req.method === 'DELETE') {
      return await handleDelete(req, res, scheduleData, fileInfo.sha, filePath, ghHeaders, GH_OWNER, GH_REPO);
    } else {
      return res.status(405).json({ error: 'method not allowed' });
    }
  } catch (err) {
    console.error('pidveska API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

const DATE_RE = /^\d{2}\.\d{2}$/;

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

async function handleAdd(req, res, scheduleData, sha, filePath, ghHeaders, owner, repo) {
  const { group, entries } = req.body || {};
  // entries = [{ date: "DD.MM", number: 1, subject: "...", teacher: "..." }, ...]
  if (!group || typeof group !== 'string' || group.length > 80) {
    return res.status(400).json({ error: 'group required (max 80 chars)' });
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'entries[] required' });
  }
  if (entries.length > 50) {
    return res.status(400).json({ error: 'Max 50 entries per request' });
  }

  if (!scheduleData[group]) {
    return res.status(404).json({ error: `Group "${group}" not found in schedule.json` });
  }

  if (!scheduleData[group]['ПІДВІСКА']) {
    scheduleData[group]['ПІДВІСКА'] = [];
  }

  const existing = new Set(
    scheduleData[group]['ПІДВІСКА'].map(e => `${e.date}|${e.number}`)
  );

  let added = 0;
  let rejected = 0;
  for (const raw of entries) {
    const e = sanitizeEntry(raw);
    if (!e) { rejected++; continue; }
    const key = `${e.date}|${e.number}`;
    if (!existing.has(key)) {
      scheduleData[group]['ПІДВІСКА'].push(e);
      existing.add(key);
      added++;
    }
  }

  if (rejected > 0 && added === 0) {
    return res.status(400).json({ error: `All ${rejected} entries had invalid format` });
  }

  if (added === 0) {
    return res.json({ ok: true, added: 0, message: 'All entries already exist' });
  }

  // Push updated schedule.json to GitHub
  await pushToGitHub(scheduleData, sha, filePath, ghHeaders, owner, repo,
    `📌 Підвіска (${group}): +${added} через бот`);

  return res.json({ ok: true, added });
}

async function handleDelete(req, res, scheduleData, sha, filePath, ghHeaders, owner, repo) {
  const { group, date, number } = req.body || {};
  if (!group || typeof group !== 'string' || group.length > 80) {
    return res.status(400).json({ error: 'group required' });
  }
  if (typeof date !== 'string' || !DATE_RE.test(date)) {
    return res.status(400).json({ error: 'date must be DD.MM' });
  }
  const para = Number(number);
  if (!Number.isFinite(para) || para < 1 || para > 8) {
    return res.status(400).json({ error: 'invalid number' });
  }

  if (!scheduleData[group] || !scheduleData[group]['ПІДВІСКА']) {
    return res.json({ ok: true, removed: 0 });
  }

  const before = scheduleData[group]['ПІДВІСКА'].length;
  scheduleData[group]['ПІДВІСКА'] = scheduleData[group]['ПІДВІСКА'].filter(
    e => !(e.date === date && e.number === para)
  );
  const removed = before - scheduleData[group]['ПІДВІСКА'].length;

  if (removed === 0) {
    return res.json({ ok: true, removed: 0 });
  }

  await pushToGitHub(scheduleData, sha, filePath, ghHeaders, owner, repo,
    `🗑 Підвіска видалена (${group}): ${date} пара ${para}`);

  return res.json({ ok: true, removed });
}

async function pushToGitHub(data, sha, filePath, headers, owner, repo, message) {
  const newContent = JSON.stringify(data, null, 2);
  const encoded = Buffer.from(newContent, 'utf-8').toString('base64');

  const putResp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
    {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, content: encoded, sha }),
    }
  );

  if (!putResp.ok) {
    const err = await putResp.json();
    throw new Error(`GitHub push failed: ${err.message || putResp.status}`);
  }
}
