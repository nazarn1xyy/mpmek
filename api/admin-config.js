const { supabase } = require('./_lib/supabase');

const ADMIN_PIN = '0411';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Pin');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Simple auth check
  const pin = req.headers['x-admin-pin'];
  if (pin !== ADMIN_PIN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('settings')
        .select('value')
        .eq('key', 'admin-config')
        .single();

      if (error && error.code !== 'PGRST116') throw error;
      return res.status(200).json(data ? data.value : {});
    }

    if (req.method === 'POST') {
      // GitHub token is no longer needed, but keep the API shape for compatibility
      const config = req.body || {};
      await supabase
        .from('settings')
        .upsert({ key: 'admin-config', value: config });

      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Admin config error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
