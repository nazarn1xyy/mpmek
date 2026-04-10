const webpush = require('web-push');
const { redis } = require('./_lib/redis');

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

    const today = new Date();
    let dayIdx = today.getDay();
    let prefix = 'Сьогодні';
    if (dayIdx === 0 || dayIdx === 6) {
      prefix = 'У понеділок';
      dayIdx = 1;
    }
    const dayName = UK_DAYS[dayIdx];

    // Fetch schedule
    const baseUrl = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL}`;
    const schedResp = await fetch(`${baseUrl}/schedule.json`);
    const scheduleData = await schedResp.json();
    delete scheduleData._settings;

    const dateStr =
      String(today.getDate()).padStart(2, '0') + '.' +
      String(today.getMonth() + 1).padStart(2, '0');

    // Get all subscriptions
    const raw = await redis('HGETALL', 'push-subs');
    if (!raw || raw.length === 0) {
      return res.status(200).json({ ok: true, sent: 0, message: 'No subscriptions found' });
    }

    const entries = [];
    for (let i = 0; i < raw.length; i += 2) {
      try {
        entries.push({ id: raw[i], ...JSON.parse(raw[i + 1]) });
      } catch {}
    }

    let sent = 0;
    const errors = [];

    for (const entry of entries) {
      try {
        const { subscription, group } = entry;
        const groupData = scheduleData[group];

        let body = `Група: ${group}\nРозклад недоступний`;

        if (groupData) {
          let weekData = groupData['ОСНОВНИЙ РОЗКЛАД'];
          if (!weekData || typeof weekData !== 'object' || Array.isArray(weekData)) {
            const types = Object.keys(groupData).filter(t => t !== 'ПІДВІСКА');
            if (types.length > 0) weekData = groupData[types[0]];
          }

          if (weekData && weekData[dayName] && weekData[dayName].length > 0) {
            let pairs = [...weekData[dayName]];
            const subs = groupData['ПІДВІСКА'] || [];
            subs.filter(s => s.date === dateStr).forEach(sub => {
              pairs = pairs.filter(p => parseInt(p.number) !== parseInt(sub.number));
              pairs.push({ ...sub, isSubstitution: true });
            });
            pairs.sort((a, b) => parseInt(a.number) - parseInt(b.number));

            const lines = pairs.map(p => {
              const t = DEFAULT_TIMES[p.number] || '';
              const mark = p.isSubstitution ? ' ⚡' : '';
              return `${p.number}. ${p.subject}${t ? ' — ' + t : ''}${mark}`;
            });
            body = lines.join('\n');
          }
        }

        const payload = JSON.stringify({
          title: `📚 ${prefix} — ${dayName}`,
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
    console.error('Test push error:', error);
    return res.status(500).json({ error: error.message });
  }
};
