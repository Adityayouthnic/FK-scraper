/**
 * Flipkart seller login. Ported from the newer, more complete selectors.py
 * (LoginSelectors) + utils.py (safeClick/safeFill with human-like pacing),
 * replacing the earlier simpler version.
 *
 * Fills the login form, but leaves CAPTCHA completion and the final submit to
 * the human whenever a CAPTCHA widget is present. Once a saved session exists
 * (see session.js), this path is only needed when that session has expired.
 */
const { LoginSelectors } = require('./selectors');
const { locatorFor, safeClick, safeFill, log, warn } = require('./utils');

const LOGIN_URL = 'https://seller.flipkart.com/';
const LOGIN_TIMEOUT_MS = 600000;
const POLL_INTERVAL_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadCredentials() {
  const email = process.env.FLIPKART_EMAIL;
  const password = process.env.FLIPKART_PASSWORD;
  if (!email || !password) {
    throw new Error('Set FLIPKART_EMAIL and FLIPKART_PASSWORD before running.');
  }
  return { email, password };
}

async function captchaIsVisible(page) {
  const captchaSelectors = [
    'iframe[src*="recaptcha"]',
    'iframe[title*="reCAPTCHA"]',
    'iframe[title*="recaptcha"]',
    '[id*="recaptcha"]',
    '[class*="recaptcha"]',
    '[id*="captcha"]',
    '[class*="captcha"]',
  ];

  for (const selector of captchaSelectors) {
    try {
      if (await locatorFor(page, selector).first().isVisible()) return true;
    } catch {
      // The login page can be changing while the widget is inserted.
    }
  }

  return page.frames().some((frame) => /(?:re)?captcha/i.test(frame.url()));
}

async function fillLoginForm(page, email, password, send) {
  const step = 'login.form';

  await page.goto(LOGIN_URL);

  await safeClick(page, LoginSelectors.LOGIN_BUTTON_XPATH, LoginSelectors.LOGIN_BUTTON_FALLBACK, step, send);
  await safeFill(page, LoginSelectors.EMAIL_INPUT_XPATH, LoginSelectors.EMAIL_INPUT_FALLBACK, email, step, send);
  await safeClick(page, LoginSelectors.NEXT_BUTTON_XPATH, LoginSelectors.NEXT_BUTTON_FALLBACK, step, send);
  await safeFill(
    page, LoginSelectors.PASSWORD_INPUT_XPATH, LoginSelectors.PASSWORD_INPUT_FALLBACK,
    password, step, send, undefined, true
  );

  if (await captchaIsVisible(page)) {
    log(
      send,
      step,
      'CAPTCHA detected. Automatic submission is paused; solve it and click Login in the live view.'
    );
    return true;
  }

  try {
    await safeClick(page, LoginSelectors.PASSWORD_SUBMIT_FALLBACK, null, step, send, 8000);
  } catch (err) {
    warn(send, step, `Auto-submit button not found (${err.message}) — waiting for manual login in the live view.`);
  }
  return false;
}

async function waitForLogin(page, send, captchaDetected, unattended = false) {
  const step = 'login.wait';
  const timeoutMs = unattended ? 45000 : LOGIN_TIMEOUT_MS;

  if (captchaDetected) {
    if (unattended) {
      throw new Error('[login.captcha] CAPTCHA detected during unattended automated run. Open the dashboard to log in once.');
    }
    log(send, step, 'Waiting for manual CAPTCHA completion and Login click in the live view.');
  } else {
    log(send, step, unattended
      ? 'Verifying automated login...'
      : 'Waiting for login to complete in the live view if Flipkart requests any extra verification.');
  }
  log(send, step, `Waiting up to ${Math.round(timeoutMs / 1000)}s for login to complete...`);

  const startUrl = page.url();
  const deadline = Date.now() + timeoutMs;
  const passwordField = page.locator(LoginSelectors.PASSWORD_INPUT_FALLBACK);

  while (Date.now() < deadline) {
    let urlChanged;
    let passwordFieldGone;
    try {
      urlChanged = page.url() !== startUrl;
      passwordFieldGone = (await passwordField.count()) === 0;
    } catch {
      // The page navigated away mid-check (context torn down) - that IS
      // the success signal we're polling for, just caught mid-flight.
      await page.waitForLoadState('load', { timeout: 15000 });
      log(send, step, `Login detected (navigation interrupted the check). Current URL: ${page.url()}`);
      return;
    }

    if (urlChanged || passwordFieldGone) {
      log(send, step, `Login detected. Current URL: ${page.url()}`);
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`[${step}] Timed out after ${Math.round(timeoutMs / 1000)}s waiting for login to complete.`);
}

async function login(page, send, options = {}) {
  const { email, password } = loadCredentials();
  const unattended = options.unattended === true;
  log(send, 'login', `Filling Flipkart seller login form${unattended ? ' (automated)' : ''}...`);
  const captchaDetected = await fillLoginForm(page, email, password, send);
  await waitForLogin(page, send, captchaDetected, unattended);
}

module.exports = { login, LOGIN_URL };
