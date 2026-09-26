/**
 * Notification / Alerting service.
 * Dispatches alerts (e.g. session expiry, CAPTCHA detected during unattended runs,
 * job success or failure) to ALERT_WEBHOOK_URL if configured.
 *
 * Payload is formatted to be universally compatible with Discord, Slack,
 * Telegram bridges, and generic webhook endpoints.
 */
const { settings } = require('./config');

async function sendAlert(title, message, extra = {}) {
  const webhookUrl = settings.ALERT_WEBHOOK_URL;
  if (!webhookUrl) return;

  const text = `**[FK Scraper] ${title}**\n${message}` +
    (extra.url ? `\n🔗 ${extra.url}` : '') +
    (extra.time ? `\n⏰ ${extra.time}` : '');

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,          // Slack / generic
        content: text, // Discord
        title,
        message,
        ...extra,
      }),
    });
  } catch (err) {
    console.error(`[alert] Failed to send webhook alert: ${err.message}`);
  }
}

module.exports = { sendAlert };
