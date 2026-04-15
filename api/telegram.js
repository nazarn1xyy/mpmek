const { safeCompare } = require('./_lib/redis');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const UK_DAYS_SHORT = {
  1: 'Пн', 2: 'Вт', 3: 'Ср', 4: 'Чт', 5: 'Пт'
};
const UK_DAYS_FULL = {
  1: 'Понеділок', 2: 'Вівторок', 3: 'Середа', 4: 'Четвер', 5: "П'ятниця"
};

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
  if (req.method !== 'POST') return res.status(200).send('ok');
  if (!BOT_TOKEN) return res.status(500).json({ error: 'no bot token' });

  // Verify request is from Telegram via webhook secret
  const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (WEBHOOK_SECRET) {
    const headerSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (!safeCompare(headerSecret, WEBHOOK_SECRET)) {
      return res.status(403).send('forbidden');
    }
  }

  const update = req.body;
  const baseUrl = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL}`;

  // Handle inline queries
  if (update.inline_query) {
    const query = update.inline_query.query.trim();
    const groups = await fetchGroups();

    // Filter groups by query
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

      // Today
      results.push(makeResult(
        `${group}-today-${Date.now()}`,
        todayDay,
        `${group} — Сьогодні`,
        UK_DAYS_FULL[todayDay] || 'Понеділок',
        'light'
      ));

      // Week
      results.push(makeResult(
        `${group}-week-${Date.now()}`,
        'week',
        `${group} — Вся неділя`,
        'Розклад на тиждень',
        'light'
      ));

      // Individual days
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
