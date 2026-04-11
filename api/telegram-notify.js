const { redis } = require('./_lib/redis');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  try {
    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    if (!BOT_TOKEN) {
      return res.status(500).json({ error: 'TG_BOT_TOKEN not configured' });
    }

    const { substitutions } = req.body;
    // substitutions = [{ group, date, number, subject, teacher }, ...]
    if (!substitutions || !Array.isArray(substitutions) || substitutions.length === 0) {
      return res.json({ ok: true, sent: 0 });
    }

    // Group subs by group name
    const byGroup = {};
    for (const sub of substitutions) {
      if (!byGroup[sub.group]) byGroup[sub.group] = [];
      byGroup[sub.group].push(sub);
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
    return res.status(500).json({ error: err.message });
  }
};

function escapeHtml(t) {
  return (t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
