const webpush = require('web-push');
const { supabase } = require('./_lib/supabase');

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
    if (!substitutions || !Array.isArray(substitutions) || substitutions.length === 0) {
      return res.status(200).json({ ok: true, sent: 0, message: 'No substitutions to notify' });
    }

    // Group subs by group name
    const byGroup = {};
    for (const sub of substitutions) {
      if (!byGroup[sub.group]) byGroup[sub.group] = [];
      byGroup[sub.group].push(sub);
    }

    // Get all push subscriptions from Supabase
    const { data: entries, error } = await supabase
      .from('push_subscriptions')
      .select('id, endpoint, keys, group_name');

    if (error) throw error;
    if (!entries || entries.length === 0) {
      return res.status(200).json({ ok: true, sent: 0, message: 'No subscriptions found' });
    }

    let sent = 0;
    const errors = [];

    for (const entry of entries) {
      try {
        const groupSubs = byGroup[entry.group_name];
        if (!groupSubs || groupSubs.length === 0) continue;

        const subscription = {
          endpoint: entry.endpoint,
          keys: entry.keys
        };

        const lines = groupSubs.map(s => `${s.date} — ${s.number} пара: ${s.subject}`);
        const body = lines.join('\n');

        const payload = JSON.stringify({
          title: `⚡ Заміна пар — ${entry.group_name}`,
          body,
          url: '/?view=today'
        });

        await webpush.sendNotification(subscription, payload);
        sent++;
      } catch (err) {
        errors.push({ id: entry.id, error: err.message, statusCode: err.statusCode });
        if (err.statusCode === 410 || err.statusCode === 404) {
          await supabase.from('push_subscriptions').delete().eq('id', entry.id);
        }
      }
    }

    return res.status(200).json({ ok: true, sent, total: entries.length, errors });
  } catch (error) {
    console.error('Notify subs error:', error);
    return res.status(500).json({ error: error.message });
  }
};
