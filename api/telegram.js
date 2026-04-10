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

      function makeResult(id, day, title, description) {
        const imgUrl = `${baseUrl}/api/schedule-image?group=${encodedGroup}&day=${day}&theme=dark&v=${v}`;
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
        `📅 ${group} — Сьогодні`,
        UK_DAYS_FULL[todayDay] || 'Понеділок'
      ));

      // Week
      results.push(makeResult(
        `${group}-week-${Date.now()}`,
        'week',
        `📋 ${group} — Вся неділя`,
        'Розклад на тиждень'
      ));

      // Individual days
      for (let d = 1; d <= 5; d++) {
        if (d === todayDay) continue;
        results.push(makeResult(
          `${group}-d${d}-${Date.now()}`,
          d,
          `${UK_DAYS_SHORT[d]} ${group}`,
          UK_DAYS_FULL[d]
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

  // Handle /start command
  if (update.message && update.message.text) {
    const chatId = update.message.chat.id;
    const text = update.message.text;

    if (text === '/start') {
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: '📚 *Розклад Студента*\n\nЩоб поділитися розкладом, напишіть в будь-якому чаті:\n\n`@ваш_бот КСМ-24-1`\n\nАбо надішліть мені назву групи, наприклад:\n`КСМ-24-1`',
        parse_mode: 'Markdown'
      });
      return res.status(200).json({ ok: true });
    }

    // Handle group name — send today + inline keyboard
    const groups = await fetchGroups();
    const group = groups.find(g => g.toLowerCase() === text.trim().toLowerCase());

    if (group) {
      const todayIdx = new Date().getDay();
      const todayDay = (todayIdx >= 1 && todayIdx <= 5) ? todayIdx : 1;
      const encodedGroup = encodeURIComponent(group);
      const imageUrl = `${baseUrl}/api/schedule-image?group=${encodedGroup}&day=${todayDay}&theme=dark`;

      await tgApi('sendPhoto', {
        chat_id: chatId,
        photo: imageUrl,
        caption: `📚 ${group} — ${UK_DAYS_FULL[todayDay]}\nmpmek.site`,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📋 Вся неділя', callback_data: `week_${group}` }
            ],
            [
              { text: 'Пн', callback_data: `d1_${group}` },
              { text: 'Вт', callback_data: `d2_${group}` },
              { text: 'Ср', callback_data: `d3_${group}` },
              { text: 'Чт', callback_data: `d4_${group}` },
              { text: 'Пт', callback_data: `d5_${group}` }
            ],
            [
              { text: '🌐 Відкрити сайт', url: 'https://mpmek.site' }
            ]
          ]
        }
      });
    } else {
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: '❌ Групу не знайдено. Надішліть точну назву, наприклад: `КСМ-24-1`',
        parse_mode: 'Markdown'
      });
    }

    return res.status(200).json({ ok: true });
  }

  // Handle callback queries (day buttons)
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id;
    const data = cb.data;

    let group, day;

    if (data.startsWith('week_')) {
      group = data.slice(5);
      day = 'week';
    } else if (data.startsWith('d')) {
      const dayNum = data.charAt(1);
      group = data.slice(3);
      day = dayNum;
    }

    if (group && day) {
      const encodedGroup = encodeURIComponent(group);
      const imageUrl = `${baseUrl}/api/schedule-image?group=${encodedGroup}&day=${day}&theme=dark`;
      const label = day === 'week' ? 'Розклад на тиждень' : UK_DAYS_FULL[parseInt(day)] || '';

      await tgApi('sendPhoto', {
        chat_id: chatId,
        photo: imageUrl,
        caption: `📚 ${group} — ${label}\nmpmek.site`
      });

      await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    }

    return res.status(200).json({ ok: true });
  }

  return res.status(200).json({ ok: true });
};
