const webpush = require('web-push');
const { redis, parseRedisEntries, safeCompare } = require('./_lib/redis');
const { decryptSubscription } = require('./_lib/push-crypto');

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Pin, X-Cron-Secret, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: accept EITHER (admin PIN + admin session) OR cron secret
  const pin = req.headers['x-admin-pin'];
  const cronSecret = req.headers['x-cron-secret'];
  const ADMIN_PIN = process.env.ADMIN_PIN;
  const CRON_SECRET = process.env.CRON_SECRET;

  const isCron = CRON_SECRET && safeCompare(cronSecret, CRON_SECRET);
  if (!isCron) {
    if (!ADMIN_PIN || !safeCompare(pin, ADMIN_PIN)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    if (!(await hasAdminSession(req))) {
      return res.status(403).json({ error: 'Admin session required' });
    }
  }

  try {
    const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
      return res.status(500).json({ error: 'VAPID keys not configured' });
    }

    webpush.setVapidDetails(
      VAPID_SUBJECT || 'mailto:admin@example.com',
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY
    );

    const { substitutions } = req.body || {};
    // substitutions = [{ group, date, number, subject, teacher }, ...]
    if (!Array.isArray(substitutions) || substitutions.length === 0) {
      return res.status(200).json({ ok: true, sent: 0, message: 'No substitutions to notify' });
    }
    if (substitutions.length > 200) {
      return res.status(400).json({ error: 'Too many substitutions (max 200)' });
    }

    // Sanitize and group subs by group name
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

    // Get all subscriptions
    const raw = await redis('HGETALL', 'push-subs');
    const entries = parseRedisEntries(raw);
    if (entries.length === 0) {
      return res.status(200).json({ ok: true, sent: 0, message: 'No subscriptions found' });
    }

    let sent = 0;
    const errors = [];

    for (const entry of entries) {
      try {
        const subscription = decryptSubscription(entry);
        if (!subscription) continue; // legacy/corrupt entry
        const { group } = entry;
        const groupSubs = byGroup[group];
        if (!groupSubs || groupSubs.length === 0) continue;

        // Build notification body
        const lines = groupSubs.map(s => `${s.date} — ${s.number} пара: ${s.subject}`);
        const body = lines.join('\n');

        const payload = JSON.stringify({
          title: `⚡ Заміна пар — ${group}`,
          body,
          url: '/?view=today'
        });

        await webpush.sendNotification(subscription, payload);
        sent++;
      } catch (err) {
        errors.push({ statusCode: err.statusCode });
        if (err.statusCode === 410 || err.statusCode === 404) {
          await redis('HDEL', 'push-subs', entry.id);
        }
      }
    }

    return res.status(200).json({ ok: true, sent, total: entries.length, errors });
  } catch (error) {
    console.error('Notify subs error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
