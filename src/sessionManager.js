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
let isLiveLoggedIn = false;
let currentSavedSession = null;

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

function markSessionUnauthenticated() {
  isLiveLoggedIn = false;
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
  isLiveLoggedIn = false;
  currentSavedSession = null;
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
    return {
      browser: liveBrowser,
      context: liveContext,
      page: livePage,
      isReused: true,
      hasSavedSession: Boolean(currentSavedSession),
    };
  }

  // Clean up any stale disconnected instance
  await closeLiveSession();

  log(send, 'session', 'Starting live browser session...');
  const savedSession = await awaitCancellable(run, loadSession(send));
  currentSavedSession = savedSession;

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
    isLiveLoggedIn = false;
    currentSavedSession = null;
    clearActivePage();
  });

  livePage = await awaitCancellable(run, liveContext.newPage(), (late) => late?.close().catch(() => {}));
  setActivePage(livePage);

  return {
    browser: liveBrowser,
    context: liveContext,
    page: livePage,
    isReused: false,
    hasSavedSession: Boolean(savedSession),
  };
}

/**
 * Verifies if the live page is already authenticated on Flipkart.
 * - If this live session already completed login earlier, reuses it immediately.
 * - If there is no saved session, initiates the Flipkart seller login flow.
 * - If a saved session exists, tests whether it redirects to dashboard; if not, logs in fresh.
 */
async function ensureAuthenticated(page, context, send, run, sessionInfo = {}) {
  const step = 'session.auth';

  // 1. If this exact live browser session already completed login in a prior run, reuse it!
  if (isLiveLoggedIn && sessionInfo.isReused) {
    try {
      const isLoginBtn = await page.locator('button:has-text("Login")').count().catch(() => 0);
      const isPass = await page.locator('input[type="password"]').count().catch(() => 0);
      const currentUrl = page.url();
      if (isLoginBtn === 0 && isPass === 0 && currentUrl.includes('seller.flipkart.com')) {
        log(send, step, `Live browser session is authenticated (${currentUrl}) — skipping login.`);
        return true;
      }
    } catch {}
    warn(send, step, 'Live session lost authentication — initiating re-login.');
    isLiveLoggedIn = false;
  }

  // 2. If NO saved session exists (e.g. brand new container boot):
  // We MUST perform login directly! We cannot assume an empty browser is logged in.
  if (!sessionInfo.hasSavedSession) {
    log(send, 'login', 'No saved session found. Initiating Flipkart seller login flow...');
    await awaitCancellable(run, login(page, send));
    await awaitCancellable(run, page.waitForTimeout(3000));
    await awaitCancellable(run, saveSession(context, send));
    isLiveLoggedIn = true;
    log(send, step, 'Login complete! Live session is now active and saved.');
    return true;
  }

  // 3. A saved session WAS loaded: verify whether the cookies are actually valid on Flipkart.
  try {
    log(send, step, 'Validating saved session on Flipkart seller portal...');
    await awaitCancellable(run, page.goto('https://seller.flipkart.com/', { waitUntil: 'domcontentloaded' }));
    await awaitCancellable(run, page.waitForTimeout(4000));

    const currentUrl = page.url();
    const hasLoginButton = await page.locator('button:has-text("Login")').count().catch(() => 0);

    // When valid, Flipkart automatically redirects from landing page into #dashboard
    if (currentUrl.includes('#dashboard') && hasLoginButton === 0) {
      isLiveLoggedIn = true;
      log(send, step, `Saved session is valid (redirected to ${currentUrl}) — skipping login.`);
      return true;
    }

    warn(send, step, `Saved session expired or invalid (current URL: ${currentUrl}) — logging in fresh.`);
  } catch (checkErr) {
    if (run.cancelled) throw checkErr;
    warn(send, step, `Session validation notice (${checkErr.message}) — logging in fresh.`);
  }

  // 4. Saved session check failed/expired: perform full login flow
  log(send, 'login', 'Initiating Flipkart seller login flow...');
  await awaitCancellable(run, login(page, send));
  await awaitCancellable(run, page.waitForTimeout(3000));
  await awaitCancellable(run, saveSession(context, send));
  isLiveLoggedIn = true;
  log(send, step, 'Login complete! Live session is now active and saved.');
  return true;
}

module.exports = {
  hasActiveLiveSession,
  getLiveSession,
  closeLiveSession,
  getOrCreateLiveSession,
  ensureAuthenticated,
  markSessionUnauthenticated,
};
