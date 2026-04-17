module.exports = (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) {
    return res.status(500).json({ error: 'VAPID key not configured' });
  }
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.json({ publicKey: key });
};
