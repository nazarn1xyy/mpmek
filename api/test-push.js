const webpush = require('web-push');
const { supabase } = require('./_lib/supabase');

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

    // Get all push subscriptions
    const { data: entries, error } = await supabase
      .from('push_subscriptions')
      .select('id, endpoint, keys, group_name');

    if (error) throw error;

    if (!entries || entries.length === 0) {
      return res.status(200).send(`
        <html><body style="background:#000;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
          <div style="text-align:center">
            <h1>⚠️ Немає підписок</h1>
            <p>Спочатку увімкніть сповіщення у додатку mpmek.site</p>
          </div>
        </body></html>
      `);
    }

    let sent = 0;
    let failed = 0;
    const toDelete = [];

    for (const entry of entries) {
      try {
        const subscription = {
          endpoint: entry.endpoint,
          keys: entry.keys
        };

        const payload = JSON.stringify({
          title: '🔔 Тестове сповіщення',
          body: `Сповіщення працюють! Група: ${entry.group_name}`,
          url: '/'
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

    // Cleanup expired
    if (toDelete.length > 0) {
      await supabase.from('push_subscriptions').delete().in('id', toDelete);
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`
      <html><body style="background:#000;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
        <div style="text-align:center">
          <h1>✅ Тест сповіщень</h1>
          <p style="font-size:20px">Відправлено: <b>${sent}</b></p>
          <p style="color:#888">Помилок: ${failed} · Очищено: ${toDelete.length}</p>
          <a href="/" style="color:#fff;margin-top:20px;display:inline-block">← На головну</a>
        </div>
      </body></html>
    `);
  } catch (err) {
    console.error('Test push error:', err);
    return res.status(500).json({ error: err.message });
  }
};
