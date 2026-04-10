const webpush = require('web-push');
const { redis } = require('../_lib/redis');

const UK_DAYS = ['Неділя', 'Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця", 'Субота'];
const DEFAULT_TIMES = { 1: '08:30', 2: '10:00', 3: '11:50', 4: '13:20', 5: '16:00', 6: '17:40' };

module.exports = async function handler(req, res) {
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

    // Current time in UTC+3 (Kyiv)
    const now = new Date();
    const utc3 = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    const dayIdx = utc3.getUTCDay();

    // Skip weekends
    if (dayIdx === 0 || dayIdx === 6) {
      return res.status(200).json({ ok: true, skipped: 'weekend' });
    }

    // Current time slot in HH:MM format (rounded to 00 or 30)
    const currentHour = String(utc3.getUTCHours()).padStart(2, '0');
    const currentMin = utc3.getUTCMinutes() < 30 ? '00' : '30';
    const currentSlot = `${currentHour}:${currentMin}`;

    const dayName = UK_DAYS[dayIdx];
    const today = utc3;

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

    // Compute today's date string DD.MM for substitution matching
    const dateStr =
      String(today.getDate()).padStart(2, '0') + '.' +
      String(today.getMonth() + 1).padStart(2, '0');

    // Get all subscriptions from Redis
    const raw = await redis('HGETALL', 'push-subs');
    if (!raw || raw.length === 0) {
      return res.status(200).json({ ok: true, sent: 0 });
    }

    // Parse HGETALL alternating [key, value, key, value, ...]
    const entries = [];
    for (let i = 0; i < raw.length; i += 2) {
      try {
        entries.push({ id: raw[i], ...JSON.parse(raw[i + 1]) });
      } catch { /* skip malformed */ }
    }

    let sent = 0;
    let failed = 0;
    const toDelete = [];

    let skipped = 0;
    for (const entry of entries) {
      try {
        const { id, subscription, group, notifyTime } = entry;

        // Only send to users whose preferred time matches current slot
        const userTime = notifyTime || '08:00';
        if (userTime !== currentSlot) {
          skipped++;
          continue;
        }

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
          url: '/?view=today'
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

    return res.status(200).json({ ok: true, sent, failed, skipped, cleaned: toDelete.length, slot: currentSlot });
  } catch (error) {
    console.error('Cron error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
