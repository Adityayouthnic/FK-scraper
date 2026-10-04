/**
 * Notification / Alerting service.
 * Dispatches alerts (e.g. session expiry, CAPTCHA detected during unattended runs,
 * job success or failure) to ALERT_WEBHOOK_URL if configured.
 *
 * Payload is formatted to be universally compatible with Discord, Slack,
 * Telegram bridges, and generic webhook endpoints.
 */
const { settings } = require('./config');

function isSafeWebhookUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const parsed = new URL(urlStr);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      hostname === '169.254.169.254' ||
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('172.16.') ||
      hostname.startsWith('172.17.') ||
      hostname.startsWith('172.18.') ||
      hostname.startsWith('172.19.') ||
      hostname.startsWith('172.2') ||
      hostname.startsWith('172.30.') ||
      hostname.startsWith('172.31.') ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.local')
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function sendAlert(title, message, extra = {}, targetUrl = null) {
  const webhookUrl = targetUrl || settings.ALERT_WEBHOOK_URL;
  if (!webhookUrl) return;

  if (!isSafeWebhookUrl(webhookUrl)) {
    console.warn(`[alert] Blocked unsafe or internal webhook URL: ${webhookUrl}`);
    return { success: false, error: 'Target webhook URL is invalid or restricted.' };
  }

  const text = `**[FK Scraper] ${title}**\n${message}` +
    (extra.url ? `\n🔗 ${extra.url}` : '') +
    (extra.time ? `\n⏰ ${extra.time}` : '');

  try {
    const res = await fetch(webhookUrl, {
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
    return { success: res.ok, status: res.status };
  } catch (err) {
    console.error(`[alert] Failed to send webhook alert: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = { sendAlert, isSafeWebhookUrl };
