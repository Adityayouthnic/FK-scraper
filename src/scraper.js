const { settings } = require('./config');
const { launchBrowser } = require('./browser');
const { loadSession, saveSession } = require('./session');
const { login } = require('./flipkartLogin');
const { navigateToWallet, selectDate, downloadWalletReport } = require('./wallet');
const { getPresentDates, missingDatesInWindow, pushToSheet } = require('./sheets');
const { log, warn } = require('./utils');
const { dateKey, formatDMonY, todayIST, addDays } = require('./dateUtil');
const {
  RunCancelledError,
  cancelActiveRun,
  dispatchInput,
  awaitCancellable,
  createRunContext,
  setupScreencast,
  setActivePage,
  clearActivePage,
  clearActiveRun,
} = require('./runner');

async function runScrapeJob(send) {
  const run = createRunContext('wallet');

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
    setActivePage(page);

    client = await setupScreencast(run, context, page, send);

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
    clearActivePage(page);
    try {
      if (browser) await browser.close();
    } catch {}
    run.resolveCancel();
    clearActiveRun(run);
  }
}

module.exports = { runScrapeJob, dispatchInput, cancelActiveRun, RunCancelledError };
