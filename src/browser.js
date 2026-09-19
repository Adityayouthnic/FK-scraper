/**
 * Playwright browser + context factory. Uses the browser's standard runtime
 * properties; CAPTCHA and any additional verification stay human-assisted.
 */
const { chromium } = require('playwright');
const { settings } = require('./config');
const { log } = require('./utils');

const STEALTH_INIT_SCRIPT = '';

/**
 * Launch Chrome and return {browser, context} with a fixed viewport.
 *
 * storageState (optional): a previously-saved session object (from
 * context.storageState()) to seed the context with, so the caller can skip
 * the login form (and the CAPTCHA it tends to trigger on a fresh,
 * cookie-less session).
 *
 * `useStealth` remains accepted for compatibility with callers from older
 * revisions, but is intentionally ignored. The login flow must not spoof
 * browser properties or attempt to bypass site verification.
 */
async function launchBrowser(send, { headless, storageState, useStealth = true } = {}) {
  const isHeadless = headless ?? settings.HEADLESS;
  log(send, 'browser.launch',
    `Launching browser (headless=${isHeadless}, viewport=${settings.VIEWPORT_WIDTH}x${settings.VIEWPORT_HEIGHT})`);

  const launchOptions = {
    headless: isHeadless,
    args: [
      `--window-size=${settings.VIEWPORT_WIDTH},${settings.VIEWPORT_HEIGHT}`,
      '--no-default-browser-check',
      '--no-first-run',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  };
  if (settings.BROWSER_CHANNEL) {
    launchOptions.channel = settings.BROWSER_CHANNEL;
  }

  const browser = await chromium.launch(launchOptions);

  const contextOptions = {
    acceptDownloads: true,
    viewport: { width: settings.VIEWPORT_WIDTH, height: settings.VIEWPORT_HEIGHT },
    screen: { width: settings.VIEWPORT_WIDTH, height: settings.VIEWPORT_HEIGHT },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  };

  if (storageState) {
    contextOptions.storageState = storageState;
    log(send, 'browser.launch', 'Loaded saved session');
  }

  const context = await browser.newContext(contextOptions);
  context.setDefaultTimeout(settings.ELEMENT_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(settings.PAGE_LOAD_TIMEOUT_MS);

  log(send, 'browser.launch', 'Browser launched with standard browser properties + India locale');
  return { browser, context };
}

module.exports = { launchBrowser, STEALTH_INIT_SCRIPT };
