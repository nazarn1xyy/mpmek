const webpush = require('web-push');
const { redis, parseRedisEntries, safeCompare } = require('../_lib/redis');
const { decryptSubscription } = require('../_lib/push-crypto');

const UK_DAYS = ['Неділя', 'Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця", 'Субота'];
const DEFAULT_TIMES = { 1: '08:30', 2: '10:00', 3: '11:50', 4: '13:20', 5: '14:50', 6: '16:20' };

module.exports = async function handler(req, res) {
  // Verify cron secret — Vercel sends Authorization: Bearer <CRON_SECRET>
  const CRON_SECRET = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  console.log('[cron] invoked, method:', req.method, 'has auth header:', !!auth, 'CRON_SECRET configured:', !!CRON_SECRET, 'user-agent:', req.headers['user-agent']);
  if (CRON_SECRET) {
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!safeCompare(token, CRON_SECRET)) {
      console.warn('[cron] auth FAILED — token length:', token.length, 'secret length:', CRON_SECRET.length);
      return res.status(401).json({ error: 'Unauthorized' });
    }
    console.log('[cron] auth OK');
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

    // Skip weekends (check in Kyiv time, not UTC — a Saturday 02:00 Kyiv is still UTC Friday)
    const today = new Date();
    const kyivDateParts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Kiev',
      year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
    }).formatToParts(today);
    const kyivWeekday = kyivDateParts.find(p => p.type === 'weekday').value; // Mon, Tue, ...
    if (kyivWeekday === 'Sat' || kyivWeekday === 'Sun') {
      return res.status(200).json({ ok: true, skipped: 'weekend' });
    }

    // Map Kyiv weekday abbreviation to dayIdx 1..5
    const WEEKDAY_MAP = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5 };
    const dayIdx = WEEKDAY_MAP[kyivWeekday];
    const dayName = UK_DAYS[dayIdx];

    // Fetch schedule data from the same deployment
    const baseUrl = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL}`;
    const schedResp = await fetch(`${baseUrl}/schedule.json`);
    if (!schedResp.ok) {
      return res.status(500).json({ error: 'Failed to fetch schedule' });
    }

    const scheduleData = await schedResp.json();
    const lessonTimes = { ...DEFAULT_TIMES };
    if (scheduleData._settings && scheduleData._settings.lessonTimes) {
      Object.assign(lessonTimes, scheduleData._settings.lessonTimes);
    }
    delete scheduleData._settings;

    // Compute today's date string DD.MM in KYIV timezone (not UTC)
    const kyivDay = kyivDateParts.find(p => p.type === 'day').value;
    const kyivMonth = kyivDateParts.find(p => p.type === 'month').value;
    const dateStr = `${kyivDay}.${kyivMonth}`;

    // Get all subscriptions from Redis.
    // Note: Hobby plan limits us to 1 cron/day, so we can't honor per-user notifyTime.
    // Send daily schedule to everyone at fixed time (05:00 UTC = 07:00–08:00 Kyiv).
    const raw = await redis('HGETALL', 'push-subs');
    const entries = parseRedisEntries(raw);
    if (entries.length === 0) {
      return res.status(200).json({ ok: true, sent: 0 });
    }

    let sent = 0;
    let failed = 0;
    const toDelete = [];

    for (const entry of entries) {
      try {
        const subscription = decryptSubscription(entry);
        if (!subscription) continue;
        const { id, group } = entry;
        const groupData = scheduleData[group];
        if (!groupData) continue;

        // Find week schedule data
        let weekData = groupData['ОСНОВНИЙ РОЗКЛАД'];
        if (!weekData || typeof weekData !== 'object' || Array.isArray(weekData)) {
          const types = Object.keys(groupData).filter(t => t !== 'ПІДВІСКА');
          if (types.length === 0) continue;
          weekData = groupData[types[0]];
        }

        if (!weekData || !weekData[dayName] || weekData[dayName].length === 0) continue;

        // Build pairs with substitutions
        let pairs = [...weekData[dayName]];
        const subs = groupData['ПІДВІСКА'] || [];
        const subsForDate = subs.filter(s => s.date === dateStr);
        subsForDate.forEach(sub => {
          pairs = pairs.filter(p => parseInt(p.number) !== parseInt(sub.number));
          pairs.push({ ...sub, isSubstitution: true });
        });

        if (pairs.length === 0) continue;
        pairs.sort((a, b) => parseInt(a.number) - parseInt(b.number));

        const lines = pairs.map(p => {
          const t = lessonTimes[p.number] || '';
          const mark = p.isSubstitution ? ' ⚡' : '';
          return `${p.number}. ${p.subject}${t ? ' — ' + t : ''}${mark}`;
        });

        const payload = JSON.stringify({
          title: `📚 Сьогодні — ${dayName}`,
          body: lines.join('\n'),
          url: `/?view=day&date=${dateStr}`
        });

        await webpush.sendNotification(subscription, payload);
        sent++;
      } catch (err) {
        failed++;
        if (err.statusCode === 410 || err.statusCode === 404) {
          toDelete.push(entry.id);
        }
      }
    }

    // Clean up expired subscriptions
    for (const id of toDelete) {
      await redis('HDEL', 'push-subs', id);
    }

    console.log('[cron] done — sent:', sent, 'failed:', failed, 'cleaned:', toDelete.length, 'totalSubs:', entries.length);
    return res.status(200).json({ ok: true, sent, failed, cleaned: toDelete.length, totalSubs: entries.length });
  } catch (error) {
    console.error('Cron error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
