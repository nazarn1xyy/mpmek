// One-time endpoint to set up the Telegram webhook
// Call: POST /api/telegram-setup with X-Admin-Pin + Authorization: Bearer <admin session>
// This will register the webhook and enable inline mode

const { redis, safeCompare, getSessionUsername } = require('./_lib/redis');

const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

async function hasAdminSession(req) {
  const uname = await getSessionUsername(req);
  if (!uname) return false;
  return ADMIN_USERNAMES.includes(uname);
}

module.exports = async function handler(req, res) {
  // Auth: require admin PIN AND admin session
  const pin = req.headers['x-admin-pin'];
  const ADMIN_PIN = process.env.ADMIN_PIN;
  if (!ADMIN_PIN || !safeCompare(pin, ADMIN_PIN)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  if (!(await hasAdminSession(req))) {
    return res.status(403).json({ error: 'Admin session required' });
  }

  const token = req.query.token || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return res.status(400).json({ error: 'token is required' });

  const baseUrl = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL}`;
  const webhookUrl = `${baseUrl}/api/telegram`;

  // Set webhook (with optional secret token for verification)
  const whPayload = { url: webhookUrl };
  const whSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (whSecret) whPayload.secret_token = whSecret;

  const whResp = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(whPayload)
  });
  const whResult = await whResp.json();

  // Get bot info
  const meResp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const meResult = await meResp.json();

  return res.status(200).json({
    webhook: whResult,
    bot: meResult.result,
    webhookUrl,
    note: 'Enable inline mode via @BotFather: /mybots → your bot → Bot Settings → Inline Mode → Turn on'
  });
};
