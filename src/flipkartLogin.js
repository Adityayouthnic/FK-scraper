const LOGIN_URL = 'https://seller.flipkart.com/';
const LOGIN_TIMEOUT_MS = 600000;
const POLL_INTERVAL_MS = 1000;

function loadCredentials() {
  const email = process.env.FLIPKART_EMAIL;
  const password = process.env.FLIPKART_PASSWORD;
  if (!email || !password) {
    throw new Error('Set FLIPKART_EMAIL and FLIPKART_PASSWORD before running.');
  }
  return { email, password };
}

async function fillLoginForm(page, email, password) {
  await page.goto(LOGIN_URL);

  await page.locator('.main-menu').getByText('Login', { exact: true }).first().click();

  const usernameField = page.locator('input[name="username"]');
  await usernameField.waitFor({ state: 'visible' });
  await usernameField.fill(email);

  // This button's visible label is "Next" but it has no accessible name,
  // so it must be matched by text content rather than by role/name.
  await page.locator('.login-modal-footer').getByText('Next', { exact: true }).first().click();

  const passwordField = page.locator('input[name="password"]');
  await passwordField.waitFor({ state: 'visible', timeout: 15000 });
  await passwordField.fill(password);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLogin(page, send) {
  send('log', {
    message: 'Credentials filled. Solve the captcha if one appears, then click Login in the live view below.',
  });
  send('log', { message: `Waiting up to ${LOGIN_TIMEOUT_MS / 60000} minutes for login to complete...` });

  const startUrl = page.url();
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;

  while (Date.now() < deadline) {
    let urlChanged;
    let passwordFieldGone;
    try {
      urlChanged = page.url() !== startUrl;
      passwordFieldGone = (await page.locator('input[name="password"]').count()) === 0;
    } catch {
      // The page navigated away mid-check (context torn down) - that IS
      // the success signal we're polling for, just caught mid-flight.
      await page.waitForLoadState('load', { timeout: 15000 });
      send('log', { message: `Login detected (navigation interrupted the check). Current URL: ${page.url()}` });
      return;
    }

    if (urlChanged || passwordFieldGone) {
      send('log', { message: `Login detected. Current URL: ${page.url()}` });
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out after ${LOGIN_TIMEOUT_MS / 1000}s waiting for login to complete.`);
}

async function login(page, send) {
  const { email, password } = loadCredentials();
  send('log', { message: 'Filling Flipkart seller login form...' });
  await fillLoginForm(page, email, password);
  await waitForLogin(page, send);
}

module.exports = { login };
