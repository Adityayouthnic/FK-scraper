/**
 * Pure Node.js IMAP OTP Reader for Zepto
 *
 * Connects securely to the Google Workspace mailbox over IMAP (imap.gmail.com:993)
 * with a Google App Password, searches for incoming OTP emails from mailer@zeptonow.com,
 * and extracts the 4-8 digit verification code.
 */

const { ImapFlow } = require('imapflow');

const OTP_SENDER = 'mailer@zeptonow.com';
const OTP_SUBJECT_HINT = 'otp';

/**
 * Extracts numeric code from text content.
 */
function extractOtpCode(text) {
  if (!text) return null;
  const clean = String(text).replace(/<[^>]+>/g, ' ');

  // Prefer code sitting close to contextual keywords (otp, code, verification)
  const nearMatch = clean.match(/(?:otp|code|verification|password)\D{0,40}?\b(\d{4,8})\b/i);
  if (nearMatch) return nearMatch[1];

  const genericMatch = clean.match(/\b(\d{4,8})\b/);
  return genericMatch ? genericMatch[1] : null;
}

/**
 * Single attempt to fetch the newest OTP message received after `sinceTs`.
 */
async function tryFetchOnce({ host, user, password, sinceTs }) {
  const client = new ImapFlow({
    host: host || 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user,
      pass: password.replace(/\s+/g, ''),
    },
    logger: false,
    emitLogs: false,
  });

  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      `IMAP connection rejected for ${user}: ${err.message}. ` +
      `Ensure IMAP_PASSWORD in Settings is a 16-character Google App Password (not your account password).`
    );
  }

  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Search for messages from Zepto sender
      const searchResults = await client.search(
        { from: OTP_SENDER },
        { uid: false }
      );

      if (!searchResults || searchResults.length === 0) {
        return null;
      }

      // Check newest messages first
      const sequenceNumbers = [...searchResults].reverse().slice(0, 5);

      for (const seq of sequenceNumbers) {
        const msg = await client.fetchOne(seq, {
          envelope: true,
          source: true,
        });

        if (!msg) continue;

        const emailDate = msg.envelope?.date ? new Date(msg.envelope.date).getTime() : 0;
        // Ignore emails received before this login attempt (with 30s clock skew allowance)
        if (emailDate && emailDate < sinceTs - 30000) {
          continue;
        }

        const subject = msg.envelope?.subject || '';
        const bodyText = msg.source ? msg.source.toString('utf8') : '';
        const fullContent = `${subject}\n${bodyText}`;

        if (OTP_SUBJECT_HINT && !subject.toLowerCase().includes(OTP_SUBJECT_HINT) && !fullContent.toLowerCase().includes(OTP_SUBJECT_HINT)) {
          continue;
        }

        const code = extractOtpCode(fullContent);
        if (code) {
          return code;
        }
      }

      return null;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Polls the mailbox until an OTP delivered after sinceTs is retrieved or timeout occurs.
 *
 * @param {Object} creds - { host, user, password }
 * @param {number} sinceTs - Timestamp (ms) when login form was submitted
 * @param {Function} logFn - Optional logger callback
 * @param {number} timeoutMs - Max wait duration (default 180s)
 * @returns {Promise<string>} OTP code
 */
async function fetchZeptoOtp(creds, sinceTs = Date.now(), logFn = () => {}, timeoutMs = 180000, checkCancelled = () => false) {
  if (!creds || !creds.user || !creds.password) {
    throw new Error('IMAP is not configured. Provide IMAP mailbox and Google App Password in Settings.');
  }

  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    if (checkCancelled && checkCancelled()) {
      throw new Error('OTP fetch cancelled by user.');
    }

    attempt++;
    try {
      const code = await tryFetchOnce({
        host: creds.host || creds.imapHost || 'imap.gmail.com',
        user: creds.user || creds.imapUser,
        password: creds.password || creds.imapPassword,
        sinceTs,
      });

      if (code) {
        logFn(`[zepto.otp] Found fresh OTP code (${code.length} digits) from mailbox.`);
        return code;
      }
    } catch (err) {
      if (err.message.includes('IMAP connection rejected')) {
        throw err;
      }
      logFn(`[zepto.otp] Check ${attempt}: ${err.message}`);
    }

    logFn(`[zepto.otp] Waiting for OTP email from ${OTP_SENDER} (attempt ${attempt})...`);

    // Sleep in small 500ms chunks to break out instantly if user cancels
    for (let s = 0; s < 14; s++) {
      if (checkCancelled && checkCancelled()) {
        throw new Error('OTP fetch cancelled by user.');
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  throw new Error(`No OTP email from ${OTP_SENDER} arrived within ${Math.round(timeoutMs / 1000)}s.`);
}

module.exports = {
  fetchZeptoOtp,
  extractOtpCode,
};
