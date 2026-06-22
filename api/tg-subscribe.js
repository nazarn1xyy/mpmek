const { safeCompare } = require('./_lib/db');
const { supabase } = require('./_lib/supabase');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://mpmek.site');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  try {
    const { chat_id, group, old_group, bot_token, action, users } = req.body || {};

    // Simple auth: require bot token
    const expectedToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!safeCompare(bot_token, expectedToken)) {
      return res.status(403).json({ error: 'unauthorized' });
    }

    // Sync bot users to Supabase
    if (action === 'sync-users') {
      if (!users || typeof users !== 'object') {
        return res.status(400).json({ error: 'invalid users data' });
      }
      const entries = Object.entries(users);
      if (entries.length > 10000) {
        return res.status(413).json({ error: 'payload too large' });
      }
      const now = new Date().toISOString();
      const rows = entries.map(([chatId, u]) => ({
        chat_id: String(chatId).slice(0, 32),
        name: (u.name || '').slice(0, 200),
        group: (u.group || '').slice(0, 80),
        notify_time: u.notify_time || '07:30',
        active: u.active !== false,
        synced_at: now
      }));
      const { error } = await supabase.from('bot_users').upsert(rows, { onConflict: 'chat_id' });
      if (error) {
        console.error('sync-users error:', error.message);
        return res.status(500).json({ error: 'DB sync failed' });
      }
      return res.json({ ok: true, count: rows.length });
    }

    // Validate chat_id (must be numeric, Telegram IDs are int64)
    const chatIdStr = String(chat_id || '').slice(0, 32);
    if (!chatIdStr || !/^-?\d+$/.test(chatIdStr)) {
      return res.status(400).json({ error: 'invalid chat_id' });
    }

    // Validate group names
    function validGroup(g) {
      return typeof g === 'string' && g.length > 0 && g.length <= 80 && !/[\x00-\x1f]/.test(g);
    }

    // Remove from old group if provided
    if (old_group && validGroup(old_group)) {
      await supabase.from('tg_subscriptions').delete().eq('chat_id', chatIdStr).eq('group_name', old_group);
    }

    // Add to new group
    if (group && validGroup(group)) {
      await supabase.from('tg_subscriptions').upsert({ chat_id: chatIdStr, group_name: group }, { onConflict: 'chat_id,group_name' });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('tg-subscribe error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
