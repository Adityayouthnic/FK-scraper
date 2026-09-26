const { settings } = require('./config');
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
  stopScreencast,
  clearActiveRun,
} = require('./runner');
const { getOrCreateLiveSession, ensureAuthenticated } = require('./sessionManager');

async function runScrapeJob(send) {
  const run = createRunContext('wallet');

  let client = null;
  let page = null;
  let context = null;
  try {
    const sessionInfo = await getOrCreateLiveSession(send, run);
    page = sessionInfo.page;
    context = sessionInfo.context;

    client = await setupScreencast(run, context, page, send);

    await ensureAuthenticated(page, context, send, run, settings.WALLET_URL);

    if (!page.url().includes('dashboard/ads/wallet/summary')) {
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
    await stopScreencast(client);
    run.resolveCancel();
    clearActiveRun(run);
  }
}

module.exports = { runScrapeJob, dispatchInput, cancelActiveRun, RunCancelledError };
