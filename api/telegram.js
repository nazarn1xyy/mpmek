const { redis } = require('./_lib/redis');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const UK_DAYS_SHORT = {
  1: 'Пн', 2: 'Вт', 3: 'Ср', 4: 'Чт', 5: 'Пт'
};
const UK_DAYS_FULL = {
  1: 'Понеділок', 2: 'Вівторок', 3: 'Середа', 4: 'Четвер', 5: "П'ятниця"
};

function escapeHtml(t) {
  return (t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function tgApi(method, body) {
  const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return resp.json();
}

async function fetchGroups() {
  const baseUrl = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL}`;
  const resp = await fetch(`${baseUrl}/schedule.json`);
  const data = await resp.json();
  delete data._settings;
  return Object.keys(data);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://mpmek.site');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || (req.body && req.body.action);

  // 1. SETUP WEBHOOK
  if (action === 'setup') {
    const token = req.query.token || BOT_TOKEN;
    if (!token) return res.status(400).json({ error: 'token is required' });

    const baseUrl = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL}`;
    const webhookUrl = `${baseUrl}/api/telegram`;

    const whResp = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl })
    });
    const whResult = await whResp.json();

    const meResp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const meResult = await meResp.json();

    return res.status(200).json({
      webhook: whResult,
      bot: meResult.result,
      webhookUrl,
      note: 'Enable inline mode via @BotFather: /mybots → your bot → Bot Settings → Inline Mode → Turn on'
    });
  }

  // 2. TG-SUBSCRIBE (Chat ID subscription to group)
  if (action === 'subscribe') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
    try {
      const { chat_id, group, old_group, bot_token } = req.body || {};
      const expectedToken = BOT_TOKEN;
      if (!expectedToken || bot_token !== expectedToken) {
        return res.status(403).json({ error: 'unauthorized' });
      }
      if (!chat_id) {
        return res.status(400).json({ error: 'chat_id required' });
      }
      if (old_group) {
        await redis('SREM', `tg_subs:${old_group}`, String(chat_id));
      }
      if (group) {
        await redis('SADD', `tg_subs:${group}`, String(chat_id));
      }
      return res.json({ ok: true });
    } catch (err) {
      console.error('tg-subscribe error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  // 3. TELEGRAM-NOTIFY (Substitutions notification broadcast)
  if (action === 'notify' || (req.body && Array.isArray(req.body.substitutions))) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
    try {
      if (!BOT_TOKEN) return res.status(500).json({ error: 'TG_BOT_TOKEN not configured' });
      const { substitutions } = req.body || {};
      if (!substitutions || !Array.isArray(substitutions) || substitutions.length === 0) {
        return res.json({ ok: true, sent: 0 });
      }

      const byGroup = {};
      for (const sub of substitutions) {
        if (!byGroup[sub.group]) byGroup[sub.group] = [];
        byGroup[sub.group].push(sub);
      }

      let sent = 0;
      let errors = 0;

      for (const [group, subs] of Object.entries(byGroup)) {
        const chatIds = await redis('SMEMBERS', `tg_subs:${group}`);
        if (!chatIds || chatIds.length === 0) continue;

        const lines = [`⚡ <b>Зміна розкладу (${escapeHtml(group)}):</b>\n`];
        for (const s of subs) {
          lines.push(`  📌 ${s.date}, ${s.number} пара — <b>${escapeHtml(s.subject)}</b>${s.teacher ? ' (' + escapeHtml(s.teacher) + ')' : ''}`);
        }
        const text = lines.join('\n');

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
  }

  // 4. TELEGRAM WEBHOOK / INLINE QUERIES
  if (req.method !== 'POST') return res.status(200).send('ok');
  if (!BOT_TOKEN) return res.status(500).json({ error: 'no bot token' });

  const update = req.body || {};
  const baseUrl = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL}`;

  // Handle inline queries
  if (update.inline_query) {
    const query = update.inline_query.query.trim();
    const groups = await fetchGroups();

    const matched = query
      ? groups.filter(g => g.toLowerCase().includes(query.toLowerCase()))
      : groups;

    const results = [];
    const v = Math.floor(Date.now() / 60000);

    for (const group of matched.slice(0, 5)) {
      const encodedGroup = encodeURIComponent(group);
      const todayIdx = new Date().getDay();
      const todayDay = (todayIdx >= 1 && todayIdx <= 5) ? todayIdx : 1;

      function makeResult(id, day, title, description, theme) {
        const imgUrl = `${baseUrl}/api/schedule-image?group=${encodedGroup}&day=${day}&theme=${theme}&v=${v}`;
        return {
          type: 'article',
          id,
          title,
          description,
          input_message_content: {
            message_text: `<a href="${imgUrl}">&#8205;</a>\n<b>${group}</b> — ${description}`,
            parse_mode: 'HTML',
            link_preview_options: {
              url: imgUrl,
              prefer_large_media: true,
              show_above_text: true
            }
          }
        };
      }

      results.push(makeResult(
        `${group}-today-${Date.now()}`,
        todayDay,
        `${group} — Сьогодні`,
        UK_DAYS_FULL[todayDay] || 'Понеділок',
        'light'
      ));

      results.push(makeResult(
        `${group}-week-${Date.now()}`,
        'week',
        `${group} — Весь тиждень`,
        'Розклад на тиждень',
        'light'
      ));

      for (let d = 1; d <= 5; d++) {
        if (d === todayDay) continue;
        results.push(makeResult(
          `${group}-d${d}-${Date.now()}`,
          d,
          `${UK_DAYS_SHORT[d]} ${group}`,
          UK_DAYS_FULL[d],
          'light'
        ));
      }
    }

    await tgApi('answerInlineQuery', {
      inline_query_id: update.inline_query.id,
      results: results.slice(0, 50),
      cache_time: 60,
      is_personal: false
    });

    return res.status(200).json({ ok: true });
  }

  return res.status(200).json({ ok: true });
};
