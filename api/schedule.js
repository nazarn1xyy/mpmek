/**
 * GET /api/schedule?group=КСМ-24-1
 * Returns schedule data for a single group (instead of the full 148KB schedule.json).
 * No auth required — public data.
 *
 * NOTE: This adds a 13th serverless function. If hitting Vercel Hobby limit (12),
 * consider consolidating with another endpoint or upgrading the plan.
 */
module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    return res.status(200).end();
  }
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const group = (req.query.group || '').trim();
  if (!group) {
    return res.status(400).json({ error: 'group parameter required' });
  }

  try {
    const baseUrl = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || 'mpmek.site'}`;
    const resp = await fetch(`${baseUrl}/schedule.json`);
    if (!resp.ok) {
      return res.status(502).json({ error: 'Failed to fetch schedule' });
    }

    const data = await resp.json();
    const settings = data._settings || {};
    const groupData = data[group];

    if (!groupData) {
      // Try normalized match (КСМ-24-1 vs КСМ-2024-1)
      const normalize = g => g.split('-').map(p =>
        /^\d{2}$/.test(p) && parseInt(p) >= 20 ? (parseInt(p) < 50 ? '20' : '19') + p : p
      ).join('-');
      const normGroup = normalize(group);
      const match = Object.keys(data).find(k => k !== '_settings' && normalize(k) === normGroup);
      if (match) {
        res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
        return res.json({ group: match, schedule: data[match], _settings: settings });
      }
      return res.status(404).json({ error: 'Group not found' });
    }

    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    return res.json({ group, schedule: groupData, _settings: settings });
  } catch (err) {
    console.error('schedule API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
