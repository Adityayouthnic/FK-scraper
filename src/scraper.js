const { settings } = require('./config');
const { launchBrowser } = require('./browser');
const { loadSession, saveSession } = require('./session');
const { login } = require('./flipkartLogin');
const { navigateToWallet, selectDate, downloadWalletReport } = require('./wallet');
const { getPresentDates, missingDatesInWindow, pushToSheet } = require('./sheets');
const { log, warn } = require('./utils');
const { dateKey, formatDMonY, todayIST, addDays } = require('./dateUtil');

const VIEWPORT = { width: settings.VIEWPORT_WIDTH, height: settings.VIEWPORT_HEIGHT };

// Tracks the single in-flight Playwright page, if any, so incoming input
// events (mouse/keyboard from the live view) can be relayed to it. There is
// at most one active run at a time (enforced in server.js).
let activePage = null;
let activeRun = null;

class RunCancelledError extends Error {
  constructor() {
    super('Run cancelled by user.');
    this.code = 'RUN_CANCELLED';
  }
}

function cancelActiveRun() {
  if (!activeRun) return false;

  activeRun.cancelled = true;
  activeRun.rejectCancel(new RunCancelledError());
  if (activeRun.browser) {
    activeRun.browser.close().catch(() => {});
  }
  return true;
}

function awaitCancellable(run, operation, onLateResolve) {
  const pending = Promise.resolve(operation);
  pending.then((value) => {
    // If cancellation won while a setup operation was still starting, clean
    // up anything that finished after the run had already been released.
    if (run.cancelled && onLateResolve) onLateResolve(value);
  }, () => {});
  return Promise.race([pending, run.cancelPromise]);
}

async function dispatchInput(evt) {
  if (!activePage) return;
  try {
    switch (evt.event) {
      case 'mousemove':
        await activePage.mouse.move(evt.x, evt.y);
        break;
      case 'mousedown':
        await activePage.mouse.move(evt.x, evt.y);
        await activePage.mouse.down({ button: evt.button || 'left' });
        break;
      case 'mouseup':
        await activePage.mouse.up({ button: evt.button || 'left' });
        break;
      case 'wheel':
        await activePage.mouse.wheel(evt.deltaX || 0, evt.deltaY || 0);
        break;
      case 'keydown':
        await activePage.keyboard.down(evt.key);
        break;
      case 'keyup':
        await activePage.keyboard.up(evt.key);
        break;
      default:
        break;
    }
  } catch {
    // Page may be mid-navigation when an input event arrives; drop it.
  }
}

async function runScrapeJob(send) {
  const run = {
    browser: null,
    cancelled: false,
    rejectCancel: null,
    resolveCancel: null,
  };
  run.cancelPromise = new Promise((resolve, reject) => {
    run.resolveCancel = resolve;
    run.rejectCancel = reject;
  });
  activeRun = run;

  let browser = null;
  let context = null;
  let page = null;
  let client = null;
  try {
    const savedSession = await awaitCancellable(run, loadSession(send));
    const launched = await awaitCancellable(
      run,
      launchBrowser(send, { storageState: savedSession, useStealth: true }),
      (lateBrowser) => lateBrowser?.browser?.close().catch(() => {})
    );
    ({ browser, context } = launched);
    run.browser = browser;

    page = await awaitCancellable(run, context.newPage(), (latePage) => latePage?.close().catch(() => {}));
    activePage = page;

    client = await awaitCancellable(run, context.newCDPSession(page));
    await awaitCancellable(run, client.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: VIEWPORT.width,
      maxHeight: VIEWPORT.height,
      everyNthFrame: 1,
    }));
    client.on('Page.screencastFrame', async ({ data, sessionId }) => {
      send('frame', { data });
      try {
        await client.send('Page.screencastFrameAck', { sessionId });
      } catch {
        // WS/browser may already be closing; safe to ignore.
      }
    });

    let loggedIn = false;

    if (savedSession) {
      try {
        await awaitCancellable(run, navigateToWallet(page, send));
        loggedIn = true;
      } catch (navErr) {
        if (run.cancelled) throw navErr;
        warn(send, 'session', `Saved session didn't work (${navErr.message}) — logging in fresh.`);
      }
    }

    if (!loggedIn) {
      await awaitCancellable(run, login(page, send));
      await awaitCancellable(run, saveSession(context, send));
      await awaitCancellable(run, navigateToWallet(page, send));
    }

    const presentDates = await awaitCancellable(run, getPresentDates(send));
    const missing = missingDatesInWindow(presentDates, settings.LOOKBACK_DAYS);

    if (missing.length === 0) {
      log(send, 'run', 'Sheet is already up to date — nothing to backfill.');
      return { rowsAdded: 0, datesProcessed: 0 };
    }

    log(send, 'run', `${missing.length} date(s) missing from the sheet: ${missing.map(formatDMonY).join(', ')}`);

    const yesterdayKey = dateKey(addDays(todayIST(), -1));
    let totalRows = 0;
    let failures = 0;

    for (const targetDate of missing) {
      const label = formatDMonY(targetDate);
      try {
        log(send, 'run', `--- Processing ${label} ---`);
        const isYesterday = dateKey(targetDate) === yesterdayKey;
        await awaitCancellable(run, selectDate(page, send, targetDate, isYesterday));
        const csvPath = await awaitCancellable(run, downloadWalletReport(page, send, targetDate));
        const rows = await awaitCancellable(run, pushToSheet(csvPath, targetDate, send));
        totalRows += rows;
      } catch (err) {
        if (run.cancelled) throw err;
        failures += 1;
        warn(send, 'run', `Failed processing ${label}: ${err.message}`);
      }
    }

    log(send, 'run',
      `Done: ${missing.length - failures}/${missing.length} date(s) processed successfully, ${totalRows} row(s) added.`);

    return { rowsAdded: totalRows, datesProcessed: missing.length, failures };
  } catch (err) {
    if (run.cancelled || err.code === 'RUN_CANCELLED') throw new RunCancelledError();
    throw err;
  } finally {
    try {
      if (client) await client.send('Page.stopScreencast');
    } catch {}
    if (activePage === page) activePage = null;
    try {
      if (browser) await browser.close();
    } catch {}
    run.resolveCancel();
    if (activeRun === run) activeRun = null;
  }
}

module.exports = { runScrapeJob, dispatchInput, cancelActiveRun };
