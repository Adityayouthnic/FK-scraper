/**
 * Live Browser & Session Manager
 *
 * Keeps a single live Playwright browser context & page open across runs
 * ("Live URL sessions"). Ensures login occurs only once; subsequent vertical
 * runs and scheduled jobs reuse the existing authenticated page without
 * launching a new browser or repeating login/CAPTCHA.
 */
const { launchBrowser } = require('./browser');
const { loadSession, saveSession } = require('./session');
const { login } = require('./flipkartLogin');
const { settings } = require('./config');
const { log, warn } = require('./utils');
const {
  awaitCancellable,
  setActivePage,
  clearActivePage,
} = require('./runner');

let liveBrowser = null;
let liveContext = null;
let livePage = null;

function hasActiveLiveSession() {
  return Boolean(
    liveBrowser &&
    liveBrowser.isConnected() &&
    livePage &&
    !livePage.isClosed()
  );
}

function getLiveSession() {
  return { browser: liveBrowser, context: liveContext, page: livePage };
}

async function closeLiveSession() {
  try {
    if (livePage && !livePage.isClosed()) {
      await livePage.close().catch(() => {});
    }
    if (liveContext) {
      await liveContext.close().catch(() => {});
    }
    if (liveBrowser && liveBrowser.isConnected()) {
      await liveBrowser.close().catch(() => {});
    }
  } catch {}
  liveBrowser = null;
  liveContext = null;
  livePage = null;
  clearActivePage();
}

/**
 * Returns the existing live browser, context, and page if still connected;
 * otherwise boots a fresh browser context seeded with the saved session.
 */
async function getOrCreateLiveSession(send, run) {
  if (hasActiveLiveSession()) {
    log(send, 'session', 'Reusing active live browser session.');
    run.browser = liveBrowser;
    setActivePage(livePage);
    return { browser: liveBrowser, context: liveContext, page: livePage, isReused: true };
  }

  // If there's any stale closed/disconnected instance, clean it up
  await closeLiveSession();

  log(send, 'session', 'Starting live browser session...');
  const savedSession = await awaitCancellable(run, loadSession(send));
  const launched = await awaitCancellable(
    run,
    launchBrowser(send, { storageState: savedSession, useStealth: true }),
    (late) => late?.browser?.close().catch(() => {})
  );

  liveBrowser = launched.browser;
  liveContext = launched.context;
  run.browser = liveBrowser;

  liveBrowser.on('disconnected', () => {
    liveBrowser = null;
    liveContext = null;
    livePage = null;
    clearActivePage();
  });

  livePage = await awaitCancellable(run, liveContext.newPage(), (late) => late?.close().catch(() => {}));
  setActivePage(livePage);

  return { browser: liveBrowser, context: liveContext, page: livePage, isReused: false };
}

/**
 * Verifies if the live page is already authenticated on the Flipkart seller dashboard.
 * If authenticated, skips the login flow completely.
 * Only if not logged in does it execute the login flow and persist the session.
 */
async function ensureAuthenticated(page, context, send, run, defaultCheckUrl) {
  const step = 'session.auth';

  // 1. Check if the page is already on a dashboard URL
  try {
    const currentUrl = page.url();
    if (currentUrl && currentUrl.includes('#dashboard')) {
      const passwordFields = await page.locator('input[type="password"]').count().catch(() => 0);
      if (passwordFields === 0) {
        log(send, step, `Live browser session is already logged in (${currentUrl}) — skipping login.`);
        return true;
      }
    }
  } catch (err) {
    if (run.cancelled) throw err;
  }

  // 2. If not on #dashboard, check if navigating to the portal opens dashboard directly
  const checkUrl = defaultCheckUrl || settings.SELLER_INSIGHTS_URL || 'https://seller.flipkart.com/index.html#dashboard/growth/seller-insights';
  try {
    log(send, step, `Checking session authentication on seller portal (${checkUrl})...`);
    await awaitCancellable(run, page.goto(checkUrl, { waitUntil: 'domcontentloaded' }));
    await awaitCancellable(run, page.waitForTimeout(3500));

    const currentUrl = page.url();
    const hasDashboard = currentUrl.includes('#dashboard');
    const passwordFields = await page.locator('input[type="password"]').count().catch(() => 0);

    if (hasDashboard && passwordFields === 0) {
      log(send, step, `Session verified and active (${currentUrl}) — skipping login.`);
      return true;
    }
  } catch (checkErr) {
    if (run.cancelled) throw checkErr;
    warn(send, step, `Session check note (${checkErr.message}) — proceeding to verify login form.`);
  }

  // 3. Not authenticated: perform login flow once
  log(send, 'login', 'Initiating Flipkart seller login flow (login required once)...');
  await awaitCancellable(run, login(page, send));
  await awaitCancellable(run, page.waitForTimeout(3000));
  await awaitCancellable(run, saveSession(context, send));
  log(send, step, 'Login complete! Live session is now active and saved.');
  return true;
}

module.exports = {
  hasActiveLiveSession,
  getLiveSession,
  closeLiveSession,
  getOrCreateLiveSession,
  ensureAuthenticated,
};
