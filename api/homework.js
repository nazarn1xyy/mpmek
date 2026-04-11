const { supabase } = require('./_lib/supabase');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const { group } = req.query;
      if (!group) return res.status(400).json({ error: 'group is required' });

      // Get group ID
      const { data: groupRow } = await supabase
        .from('groups')
        .select('id')
        .eq('name', group)
        .single();

      if (!groupRow) return res.json({});

      const { data: rows, error } = await supabase
        .from('homework')
        .select('day, number, text')
        .eq('group_id', groupRow.id);

      if (error) throw error;

      // Convert to the format app.js expects: { "group|day|number": "text" }
      const result = {};
      for (const row of rows) {
        result[`${group}|${row.day}|${row.number}`] = row.text;
      }
      return res.json(result);
    }

    if (req.method === 'POST') {
      const { group, day, number, text } = req.body;
      if (!group || !day || number === undefined) {
        return res.status(400).json({ error: 'group, day, number required' });
      }

      // Get group ID
      const { data: groupRow } = await supabase
        .from('groups')
        .select('id')
        .eq('name', group)
        .single();

      if (!groupRow) return res.status(404).json({ error: 'group not found' });

      if (text && text.trim()) {
        await supabase
          .from('homework')
          .upsert({
            group_id: groupRow.id,
            day,
            number: parseInt(number),
            text: text.trim(),
            updated_at: new Date().toISOString()
          }, { onConflict: 'group_id,day,number' });
      } else {
        await supabase
          .from('homework')
          .delete()
          .match({ group_id: groupRow.id, day, number: parseInt(number) });
      }
      return res.json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const { group, day, number } = req.query;
      if (!group || !day || number === undefined) {
        return res.status(400).json({ error: 'group, day, number required' });
      }

      const { data: groupRow } = await supabase
        .from('groups')
        .select('id')
        .eq('name', group)
        .single();

      if (!groupRow) return res.json({ ok: true });

      await supabase
        .from('homework')
        .delete()
        .match({ group_id: groupRow.id, day, number: parseInt(number) });

      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    console.error('homework API error:', err);
    return res.status(500).json({ error: err.message });
  }
};
