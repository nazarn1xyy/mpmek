const { safeCompare, getSessionUsername } = require('./_lib/db');
const { ADMIN_USERNAMES } = require('./_lib/config');

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

function escapeHtml(t) {
  return (t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function hasAdminSession(req) {
  const uname = await getSessionUsername(req);
  if (!uname) return false;
  return ADMIN_USERNAMES.includes(uname);
}

// ─── Webhook handler (POST from Telegram, no query params) ──

async function handleWebhook(req, res) {
  if (req.method !== 'POST') return res.status(200).send('ok');
  if (!BOT_TOKEN) return res.status(500).json({ error: 'no bot token' });

  const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (WEBHOOK_SECRET) {
    const headerSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (!safeCompare(headerSecret, WEBHOOK_SECRET)) {
      return res.status(403).send('forbidden');
    }
  }

  const update = req.body;
  const baseUrl = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL}`;

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
}

// ─── Setup webhook (?action=setup) ──────────────────────────

async function handleSetup(req, res) {
  const pin = req.headers['x-admin-pin'];
  const ADMIN_PIN = process.env.ADMIN_PIN;
  if (!ADMIN_PIN || !safeCompare(pin, ADMIN_PIN)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  if (!(await hasAdminSession(req))) {
    return res.status(403).json({ error: 'Admin session required' });
  }

  const token = req.query.token || BOT_TOKEN;
  if (!token) return res.status(400).json({ error: 'token is required' });

  const baseUrl = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL}`;
  const webhookUrl = `${baseUrl}/api/telegram`;

  const whPayload = { url: webhookUrl };
  const whSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (whSecret) whPayload.secret_token = whSecret;

  const whResp = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(whPayload)
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

// ─── Notify subscribers (?action=notify) ─────────────────────

async function handleNotify(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://mpmek.site');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Pin, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const pin = req.headers['x-admin-pin'];
  const ADMIN_PIN = process.env.ADMIN_PIN;
  if (!ADMIN_PIN || !safeCompare(pin, ADMIN_PIN)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  if (!(await hasAdminSession(req))) {
    return res.status(403).json({ error: 'Admin session required' });
  }

  try {
    if (!BOT_TOKEN) return res.status(500).json({ error: 'TG_BOT_TOKEN not configured' });

    const { substitutions } = req.body || {};
    if (!Array.isArray(substitutions) || substitutions.length === 0) {
      return res.json({ ok: true, sent: 0 });
    }
    if (substitutions.length > 200) {
      return res.status(400).json({ error: 'Too many substitutions (max 200)' });
    }

    const byGroup = {};
    for (const sub of substitutions) {
      if (!sub || typeof sub !== 'object') continue;
      const group = typeof sub.group === 'string' ? sub.group.slice(0, 80) : '';
      const date = typeof sub.date === 'string' ? sub.date.slice(0, 10) : '';
      const number = Number(sub.number);
      const subject = typeof sub.subject === 'string' ? sub.subject.slice(0, 200) : '';
      const teacher = typeof sub.teacher === 'string' ? sub.teacher.slice(0, 100) : '';
      if (!group || !date || !Number.isFinite(number)) continue;
      if (!byGroup[group]) byGroup[group] = [];
      byGroup[group].push({ group, date, number, subject, teacher });
    }

    const { supabase } = require('./_lib/supabase');

    let sent = 0;
    let errors = 0;

    for (const [group, subs] of Object.entries(byGroup)) {
      const { data: subscribers } = await supabase
        .from('tg_subscriptions')
        .select('chat_id')
        .eq('group_name', group);

      if (!subscribers || subscribers.length === 0) continue;

      const lines = [`⚡ <b>Зміна розкладу (${escapeHtml(group)}):</b>\n`];
      for (const s of subs) {
        lines.push(`  📌 ${s.date}, ${s.number} пара — <b>${escapeHtml(s.subject)}</b>${s.teacher ? ' (' + escapeHtml(s.teacher) + ')' : ''}`);
      }
      const text = lines.join('\n');

      for (const sub of subscribers) {
        try {
          const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: sub.chat_id, text, parse_mode: 'HTML' }),
          });
          if (resp.ok) {
            sent++;
          } else {
            const err = await resp.json();
            if (err.error_code === 403 || err.error_code === 400) {
              await supabase.from('tg_subscriptions').delete().eq('chat_id', sub.chat_id).eq('group_name', group);
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
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Router ──────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  const action = req.query.action;

  if (action === 'setup') return await handleSetup(req, res);
  if (action === 'notify') return await handleNotify(req, res);

  return await handleWebhook(req, res);
};
