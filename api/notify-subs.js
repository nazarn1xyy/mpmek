const webpush = require('web-push');
const { redis, parseRedisEntries } = require('./_lib/redis');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
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

    const { substitutions } = req.body;
    // substitutions = [{ group, date, number, subject, teacher }, ...]
    if (!substitutions || !Array.isArray(substitutions) || substitutions.length === 0) {
      return res.status(200).json({ ok: true, sent: 0, message: 'No substitutions to notify' });
    }

    // Group subs by group name
    const byGroup = {};
    for (const sub of substitutions) {
      if (!byGroup[sub.group]) byGroup[sub.group] = [];
      byGroup[sub.group].push(sub);
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
        const { subscription, group } = entry;
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
        errors.push({ id: entry.id, error: err.message, statusCode: err.statusCode });
        if (err.statusCode === 410 || err.statusCode === 404) {
          await redis('HDEL', 'push-subs', entry.id);
        }
      }
    }

    return res.status(200).json({ ok: true, sent, total: entries.length, errors });
  } catch (error) {
    console.error('Notify subs error:', error);
    return res.status(500).json({ error: error.message });
  }
};
