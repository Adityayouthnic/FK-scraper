/**
 * Playwright browser + context factory. Includes a stealth init-script that
 * patches several JS properties commonly used by bot-detection systems
 * (navigator.webdriver, plugins, languages, window.chrome, permissions API,
 * WebGL vendor/renderer, hardware concurrency).
 */
const { chromium } = require('playwright');
const { settings } = require('./config');
const { log } = require('./utils');

const STEALTH_INIT_SCRIPT = `
// 1. Hide the webdriver flag
Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined
});

// 2. Populate plugins (bot detectors check for empty navigator.plugins)
Object.defineProperty(navigator, 'plugins', {
    get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer',
          description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer',
          filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin',
          description: '' }
    ]
});

// 3. Languages — plausible for an Indian user
Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en', 'hi-IN', 'hi']
});

// 4. window.chrome must exist in real Chrome
window.chrome = {
    runtime: {},
    loadTimes: function() {},
    csi: function() {},
    app: {}
};

// 5. permissions.query — real Chrome doesn't return 'denied' for notifications
//    in the same way headless does.
const originalQuery = window.navigator.permissions.query;
window.navigator.permissions.query = (parameters) => (
    parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters)
);

// 6. Spoof WebGL vendor/renderer so the fingerprint looks like a real GPU
const getParameter = WebGLRenderingContext.prototype.getParameter;
WebGLRenderingContext.prototype.getParameter = function(parameter) {
    if (parameter === 37445) return 'Intel Inc.';
    if (parameter === 37446) return 'Intel Iris OpenGL Engine';
    return getParameter.apply(this, arguments);
};

// 7. Hardware concurrency looks realistic
Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
`;

/**
 * Launch Chrome and return {browser, context} with stealth + fixed viewport.
 *
 * storageState (optional): a previously-saved session object (from
 * context.storageState()) to seed the context with, so the caller can skip
 * the login form (and the CAPTCHA it tends to trigger on a fresh,
 * cookie-less session).
 *
 * useStealth should stay on for the unattended run, but a real human
 * solving a CAPTCHA manually doesn't need it — a spoofed/inconsistent WebGL
 * fingerprint is a known way to make CAPTCHA widgets hang instead of
 * rendering the challenge.
 */
async function launchBrowser(send, { headless, storageState, useStealth = true } = {}) {
  const isHeadless = headless ?? settings.HEADLESS;
  log(send, 'browser.launch',
    `Launching browser (headless=${isHeadless}, viewport=${settings.VIEWPORT_WIDTH}x${settings.VIEWPORT_HEIGHT})`);

  const launchOptions = {
    headless: isHeadless,
    args: [
      `--window-size=${settings.VIEWPORT_WIDTH},${settings.VIEWPORT_HEIGHT}`,
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--no-default-browser-check',
      '--no-first-run',
      '--disable-infobars',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
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
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  };

  if (storageState) {
    contextOptions.storageState = storageState;
    log(send, 'browser.launch', 'Loaded saved session');
  }

  const context = await browser.newContext(contextOptions);
  context.setDefaultTimeout(settings.ELEMENT_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(settings.PAGE_LOAD_TIMEOUT_MS);

  if (useStealth) {
    await context.addInitScript(STEALTH_INIT_SCRIPT);
  }

  log(send, 'browser.launch', `Browser launched with stealth=${useStealth ? 'on' : 'off'} + India locale`);
  return { browser, context };
}

module.exports = { launchBrowser, STEALTH_INIT_SCRIPT };
