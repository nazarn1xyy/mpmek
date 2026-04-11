const webpush = require('web-push');
const { supabase } = require('../_lib/supabase');

const UK_DAYS = ['Неділя', 'Понеділок', 'Вівторок', 'Середа', 'Четвер', "П'ятниця", 'Субота'];
const DEFAULT_TIMES = { 1: '08:30', 2: '10:00', 3: '11:50', 4: '13:20', 5: '14:50', 6: '16:20' };

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

    // Skip weekends
    const today = new Date();
    const dayIdx = today.getDay();
    if (dayIdx === 0 || dayIdx === 6) {
      return res.status(200).json({ ok: true, skipped: 'weekend' });
    }

    const dayName = UK_DAYS[dayIdx];
    const dateStr =
      String(today.getDate()).padStart(2, '0') + '.' +
      String(today.getMonth() + 1).padStart(2, '0');

    // Get lesson times from settings
    const lessonTimes = { ...DEFAULT_TIMES };
    const { data: timesRow } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'lessonTimes')
      .single();
    if (timesRow) Object.assign(lessonTimes, timesRow.value);

    // Get all push subscriptions
    const { data: entries, error } = await supabase
      .from('push_subscriptions')
      .select('id, endpoint, keys, group_name');

    if (error) throw error;
    if (!entries || entries.length === 0) {
      return res.status(200).json({ ok: true, sent: 0 });
    }

    // Get unique groups from subscriptions
    const uniqueGroups = [...new Set(entries.map(e => e.group_name))];

    // Fetch schedule data for all needed groups
    const groupSchedules = {};
    for (const groupName of uniqueGroups) {
      const { data: groupRow } = await supabase
        .from('groups')
        .select('id')
        .eq('name', groupName)
        .single();
      if (!groupRow) continue;

      const groupId = groupRow.id;

      // Get today's schedule
      const { data: schedRows } = await supabase
        .from('schedules')
        .select('number, subject, teacher')
        .eq('group_id', groupId)
        .eq('day', dayName)
        .order('number');

      // Get substitutions for today
      const { data: subsRows } = await supabase
        .from('substitutions')
        .select('number, subject, teacher')
        .eq('group_id', groupId)
        .eq('date', dateStr);

      if (!schedRows || schedRows.length === 0) continue;

      let pairs = [...schedRows];
      if (subsRows && subsRows.length > 0) {
        subsRows.forEach(sub => {
          pairs = pairs.filter(p => parseInt(p.number) !== parseInt(sub.number));
          pairs.push({ ...sub, isSubstitution: true });
        });
      }
      pairs.sort((a, b) => parseInt(a.number) - parseInt(b.number));

      groupSchedules[groupName] = pairs;
    }

    let sent = 0;
    let failed = 0;
    const toDelete = [];

    for (const entry of entries) {
      try {
        const pairs = groupSchedules[entry.group_name];
        if (!pairs || pairs.length === 0) continue;

        const subscription = {
          endpoint: entry.endpoint,
          keys: entry.keys
        };

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
    if (toDelete.length > 0) {
      await supabase
        .from('push_subscriptions')
        .delete()
        .in('id', toDelete);
    }

    return res.status(200).json({ ok: true, sent, failed, cleaned: toDelete.length });
  } catch (error) {
    console.error('Cron error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
