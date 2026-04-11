/**
 * API for managing підвіска (substitutions) via Supabase.
 * POST: add підвіска entries
 * DELETE: remove a підвіска entry
 * Auth: bot_token must match TELEGRAM_BOT_TOKEN env var
 */

const { supabase } = require('./_lib/supabase');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!BOT_TOKEN) {
    return res.status(500).json({ error: 'Missing TELEGRAM_BOT_TOKEN env var' });
  }

  // Auth check
  const { bot_token } = req.body || {};
  if (bot_token !== BOT_TOKEN) {
    return res.status(403).json({ error: 'unauthorized' });
  }

  try {
    if (req.method === 'POST') {
      return await handleAdd(req, res);
    } else if (req.method === 'DELETE') {
      return await handleDelete(req, res);
    }
    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    console.error('pidveska API error:', err);
    return res.status(500).json({ error: err.message });
  }
};

async function handleAdd(req, res) {
  const { group, entries } = req.body;
  if (!group || !entries || !Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'group and entries[] required' });
  }

  // Get group ID
  const { data: groupRow, error: groupErr } = await supabase
    .from('groups')
    .select('id')
    .eq('name', group)
    .single();

  if (groupErr || !groupRow) {
    return res.status(404).json({ error: `Group "${group}" not found` });
  }

  const rows = entries.map(e => ({
    group_id: groupRow.id,
    date: e.date,
    number: e.number,
    subject: e.subject || '',
    teacher: e.teacher || ''
  }));

  const { data: inserted, error } = await supabase
    .from('substitutions')
    .upsert(rows, { onConflict: 'group_id,date,number' })
    .select();

  if (error) throw error;

  return res.json({ ok: true, added: inserted ? inserted.length : 0 });
}

async function handleDelete(req, res) {
  const { group, date, number } = req.body;
  if (!group || !date || number == null) {
    return res.status(400).json({ error: 'group, date, and number required' });
  }

  const { data: groupRow } = await supabase
    .from('groups')
    .select('id')
    .eq('name', group)
    .single();

  if (!groupRow) return res.json({ ok: true, removed: 0 });

  const para = typeof number === 'string' ? parseInt(number) : number;

  const { data: deleted, error } = await supabase
    .from('substitutions')
    .delete()
    .match({ group_id: groupRow.id, date, number: para })
    .select();

  if (error) throw error;

  return res.json({ ok: true, removed: deleted ? deleted.length : 0 });
}
