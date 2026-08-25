/**
 * Flipkart seller login. Ported from the newer, more complete selectors.py
 * (LoginSelectors) + utils.py (safeClick/safeFill with human-like pacing),
 * replacing the earlier simpler version.
 *
 * Auto-fills and attempts to auto-submit the login form. If Flipkart shows
 * a CAPTCHA (common on a fresh, cookie-less session), the auto-submit click
 * either no-ops or gets blocked by it — either way, waitForLogin below just
 * keeps polling for success, and a human can finish it live from the
 * streamed browser view. Once a saved session exists (see session.js),
 * this path is only needed when that session has expired.
 */
const { LoginSelectors } = require('./selectors');
const { safeClick, safeFill, log, warn } = require('./utils');

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

  try {
    await safeClick(page, LoginSelectors.PASSWORD_SUBMIT_FALLBACK, null, step, send, 8000);
  } catch (err) {
    warn(send, step, `Auto-submit button not found (${err.message}) — waiting for manual login in the live view.`);
  }
}

async function waitForLogin(page, send) {
  const step = 'login.wait';
  log(send, step, 'Solve the captcha if one appears, then click Login in the live view below.');
  log(send, step, `Waiting up to ${LOGIN_TIMEOUT_MS / 60000} minutes for login to complete...`);

  const startUrl = page.url();
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
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

  throw new Error(`[${step}] Timed out after ${LOGIN_TIMEOUT_MS / 1000}s waiting for login to complete.`);
}

async function login(page, send) {
  const { email, password } = loadCredentials();
  log(send, 'login', 'Filling Flipkart seller login form...');
  await fillLoginForm(page, email, password, send);
  await waitForLogin(page, send);
}

module.exports = { login, LOGIN_URL };
