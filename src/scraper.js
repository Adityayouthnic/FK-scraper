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
  const savedSession = await loadSession(send);
  const { browser, context } = await launchBrowser(send, { storageState: savedSession, useStealth: true });
  const page = await context.newPage();
  activePage = page;

  const client = await context.newCDPSession(page);
  await client.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 60,
    maxWidth: VIEWPORT.width,
    maxHeight: VIEWPORT.height,
    everyNthFrame: 1,
  });
  client.on('Page.screencastFrame', async ({ data, sessionId }) => {
    send('frame', { data });
    try {
      await client.send('Page.screencastFrameAck', { sessionId });
    } catch {
      // WS/browser may already be closing; safe to ignore.
    }
  });

  try {
    let loggedIn = false;

    if (savedSession) {
      try {
        await navigateToWallet(page, send);
        loggedIn = true;
      } catch (navErr) {
        warn(send, 'session', `Saved session didn't work (${navErr.message}) — logging in fresh.`);
      }
    }

    if (!loggedIn) {
      await login(page, send);
      await saveSession(context, send);
      await navigateToWallet(page, send);
    }

    const presentDates = await getPresentDates(send);
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
        await selectDate(page, send, targetDate, isYesterday);
        const csvPath = await downloadWalletReport(page, send, targetDate);
        const rows = await pushToSheet(csvPath, targetDate, send);
        totalRows += rows;
      } catch (err) {
        failures += 1;
        warn(send, 'run', `Failed processing ${label}: ${err.message}`);
      }
    }

    log(send, 'run',
      `Done: ${missing.length - failures}/${missing.length} date(s) processed successfully, ${totalRows} row(s) added.`);

    return { rowsAdded: totalRows, datesProcessed: missing.length, failures };
  } finally {
    try {
      await client.send('Page.stopScreencast');
    } catch {}
    activePage = null;
    await browser.close();
  }
}

module.exports = { runScrapeJob, dispatchInput };
