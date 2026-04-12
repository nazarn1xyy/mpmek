// One-time endpoint to set up the Telegram webhook
// Call: GET /api/telegram-setup?token=YOUR_BOT_TOKEN
// This will register the webhook and enable inline mode

module.exports = async function handler(req, res) {
  const token = req.query.token || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return res.status(400).json({ error: 'token is required' });

  const baseUrl = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL}`;
  const webhookUrl = `${baseUrl}/api/telegram`;

  // Set webhook
  const whResp = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl })
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
