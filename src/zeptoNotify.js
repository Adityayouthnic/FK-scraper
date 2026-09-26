/**
 * Zepto Failure Email Notifier
 *
 * Sends alert emails on job failure using the configured Google Workspace credentials over SMTP.
 */

const nodemailer = require('nodemailer');
const { getRawZeptoCredentials } = require('./credentials');

async function sendZeptoFailureAlert(subject, body) {
  const creds = getRawZeptoCredentials();
  const imapUser = creds.imapUser || process.env.IMAP_USER;
  const imapPassword = creds.imapPassword || process.env.IMAP_PASSWORD;
  const notifyTo = creds.notifyTo || process.env.NOTIFY_TO || imapUser;

  if (!imapUser || !imapPassword || !notifyTo) {
    return false;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: imapUser,
        pass: imapPassword.replace(/\s+/g, ''),
      },
    });

    await transporter.sendMail({
      from: `"Zepto Scraper Alert" <${imapUser}>`,
      to: notifyTo,
      subject: `[Zepto Sync] ${subject}`,
      text: body,
    });

    return true;
  } catch (err) {
    console.warn('[zepto.notify] Could not send failure alert email:', err.message);
    return false;
  }
}

module.exports = { sendZeptoFailureAlert };
