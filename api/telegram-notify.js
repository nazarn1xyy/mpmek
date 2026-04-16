const { redis, safeCompare } = require('./_lib/redis');

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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://mpmek.site');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Pin, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  // Auth: require admin PIN AND admin session
  const pin = req.headers['x-admin-pin'];
  const ADMIN_PIN = process.env.ADMIN_PIN;
  if (!ADMIN_PIN || !safeCompare(pin, ADMIN_PIN)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  if (!(await hasAdminSession(req))) {
    return res.status(403).json({ error: 'Admin session required' });
  }

  try {
    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    if (!BOT_TOKEN) {
      return res.status(500).json({ error: 'TG_BOT_TOKEN not configured' });
    }

    const { substitutions } = req.body || {};
    // substitutions = [{ group, date, number, subject, teacher }, ...]
    if (!Array.isArray(substitutions) || substitutions.length === 0) {
      return res.json({ ok: true, sent: 0 });
    }
    if (substitutions.length > 200) {
      return res.status(400).json({ error: 'Too many substitutions (max 200)' });
    }

    // Sanitize and group
    const byGroup = {};
    for (const sub of substitutions) {
      if (!sub || typeof sub !== 'object') continue;
      const group = typeof sub.group === 'string' ? sub.group.slice(0, 80) : '';
      const date = typeof sub.date === 'string' ? sub.date.slice(0, 10) : '';
      const number = Number(sub.number);
      const subject = typeof sub.subject === 'string' ? sub.subject.slice(0, 200) : '';
      const teacher = typeof sub.teacher === 'string' ? sub.teacher.slice(0, 100) : '';
      if (!group || !date || !Number.isFinite(number)) continue;
      if (!byGroup[group]) byGroup[group] = [];
      byGroup[group].push({ group, date, number, subject, teacher });
    }

    let sent = 0;
    let errors = 0;

    for (const [group, subs] of Object.entries(byGroup)) {
      // Get subscribers for this group from Redis SET
      const chatIds = await redis('SMEMBERS', `tg_subs:${group}`);
      if (!chatIds || chatIds.length === 0) continue;

      // Build message
      const lines = [`⚡ <b>Зміна розкладу (${escapeHtml(group)}):</b>\n`];
      for (const s of subs) {
        lines.push(`  📌 ${s.date}, ${s.number} пара — <b>${escapeHtml(s.subject)}</b>${s.teacher ? ' (' + escapeHtml(s.teacher) + ')' : ''}`);
      }
      const text = lines.join('\n');

      // Send to each subscriber
      for (const chatId of chatIds) {
        try {
          const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text,
              parse_mode: 'HTML',
            }),
          });
          if (resp.ok) {
            sent++;
          } else {
            const err = await resp.json();
            // If user blocked bot or chat not found, remove from subscribers
            if (err.error_code === 403 || err.error_code === 400) {
              await redis('SREM', `tg_subs:${group}`, String(chatId));
            }
            errors++;
          }
        } catch {
          errors++;
        }
      }
    }

    return res.json({ ok: true, sent, errors });
  } catch (err) {
    console.error('telegram-notify error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

function escapeHtml(t) {
  return (t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
