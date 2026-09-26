/**
 * Search Trends scraping: for configured vertical(s), page through the Growth ->
 * NXT Insights -> Search Trends table and collect:
 *   - Searched Term
 *   - Weekly search volume
 *   - % Of Change
 *   - CTR%
 *   - Units Sold
 *   - No. of Products Shown
 *
 * Then pushes each vertical to the Search_Trends tab in Google Sheets.
 */
const { settings } = require('./config');
const { launchBrowser } = require('./browser');
const { loadSession, saveSession } = require('./session');
const { login } = require('./flipkartLogin');
const { pushTrends } = require('./trendsSheets');
const { log, warn, humanPause } = require('./utils');
const { todayIST } = require('./dateUtil');
const {
  RunCancelledError,
  awaitCancellable,
  createRunContext,
  setupScreencast,
  setActivePage,
  clearActivePage,
  clearActiveRun,
} = require('./runner');

// slug (used in the page URL) -> display label (matches the sheet's existing casing)
const VERTICALS = {
  women_ethnic_set: 'Women Ethnic Set',
  women_sari: 'Women Sari',
  Women_Kurta_And_Kurti: 'Women Kurta And Kurti',
};

const EXTRACT_ROWS_JS = `
() => {
  const rows = [...document.querySelectorAll('table[data-testid="grid-component"] tbody tr')];
  return rows.map(tr => {
    const tds = tr.querySelectorAll('td');
    if (tds.length < 6) return null;
    const term = tds[0].querySelector('.styles__ProdTitle-sc-jw88a7-0')?.textContent.trim() || '';
    const volume = tds[2].querySelector('.styles__VolumeValue-sc-1llvjli-0')?.textContent.trim() || '';
    const arrowEl = tds[2].querySelector('.styles__ArrowIcon-sc-1llvjli-1');
    const change = arrowEl ? arrowEl.textContent.trim() : '';
    const ctr = tds[3].querySelector('.styles__CtrCell-sc-1llvjli-2')?.textContent.trim() || '';
    const units = tds[4].querySelector('.styles__CtrCell-sc-1llvjli-2')?.textContent.trim() || '';
    const products = tds[5].querySelector('.styles__CtrCell-sc-1llvjli-2')?.textContent.trim() || '';
    return { term, volume, change, ctr, units, products };
  }).filter(Boolean);
}
`;

/**
 * Scrape `pages` pages (50 rows each) of Search Trends for one vertical.
 */
async function scrapeVertical(page, send, run, verticalSlug, pagesToScrape) {
  const step = 'trends.scrape';
  const verticalLabel = VERTICALS[verticalSlug] || verticalSlug;

  const baseUrl = settings.SELLER_INSIGHTS_URL || 'https://seller.flipkart.com/index.html#dashboard/growth/seller-insights';
  const url = `${baseUrl}?businessVertical=ALL&section=search_trends&selectedVertical=${verticalSlug}`;

  log(send, step, `Navigating to Search Trends for '${verticalLabel}'`);
  await awaitCancellable(run, page.goto(url, { waitUntil: 'domcontentloaded' }));

  try {
    await awaitCancellable(run, page.waitForLoadState('networkidle', { timeout: settings.PAGE_LOAD_TIMEOUT_MS }));
  } catch {
    // If networkidle times out, proceed if DOM is ready
  }
  await awaitCancellable(run, page.waitForTimeout(3000));

  log(send, step, `Waiting for trends grid to load for '${verticalLabel}'...`);
  await awaitCancellable(
    run,
    page.waitForSelector('table[data-testid="grid-component"] tbody tr', { timeout: settings.ELEMENT_TIMEOUT_MS })
  );
  await awaitCancellable(run, page.waitForTimeout(800));

  const allRows = [];
  for (let pageNum = 1; pageNum <= pagesToScrape; pageNum++) {
    if (run.cancelled) throw new RunCancelledError();

    const rows = await awaitCancellable(run, page.evaluate(EXTRACT_ROWS_JS));
    log(send, step, `Page ${pageNum}/${pagesToScrape} for '${verticalLabel}': extracted ${rows.length} rows`);
    allRows.push(...rows);

    if (pageNum < pagesToScrape) {
      const firstTermBefore = rows.length > 0 ? rows[0].term : null;
      const maxAttempts = 3;
      let lastErr = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (run.cancelled) throw new RunCancelledError();
        try {
          const nextBtn = page.locator('[data-testid="next-page-button"]');
          const isVisible = await nextBtn.isVisible().catch(() => false);
          if (!isVisible) {
            log(send, step, `Next page button not visible on page ${pageNum}. Ending pagination for '${verticalLabel}'.`);
            lastErr = null;
            break;
          }

          const isDisabled = await nextBtn.evaluate(
            (el) => el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('disabled')
          ).catch(() => false);

          if (isDisabled) {
            log(send, step, `Next page button disabled on page ${pageNum}. Reached last available page.`);
            lastErr = null;
            break;
          }

          await nextBtn.scrollIntoViewIfNeeded().catch(() => {});
          await humanPause(send, `${step}.next_page`);
          await nextBtn.click();

          // Wait for first row's term to actually change, confirming new page loaded
          await page.waitForFunction(
            (prevTerm) => {
              const el = document.querySelector(
                'table[data-testid="grid-component"] tbody tr td .styles__ProdTitle-sc-jw88a7-0'
              );
              return el && el.textContent.trim() !== prevTerm;
            },
            firstTermBefore,
            { timeout: 15000 }
          );
          lastErr = null;
          break;
        } catch (clickErr) {
          lastErr = clickErr;
          warn(send, step, `Page ${pageNum}->${pageNum + 1} attempt ${attempt}/${maxAttempts} failed: ${clickErr.message}`);
          await page.waitForTimeout(2000);
        }
      }

      if (lastErr) {
        throw new Error(
          `[${step}] Could not advance from page ${pageNum} to ${pageNum + 1} after ${maxAttempts} attempts: ${lastErr.message}`
        );
      }

      await page.waitForTimeout(500);
    }
  }

  log(send, step, `Collected ${allRows.length} rows for '${verticalLabel}' across ${pagesToScrape} pages`);
  return allRows;
}

/**
 * Execute the complete Search Trends scraping job.
 * Shares the exact same login flow, screencast streaming, and session persistence as Wallet Scraper.
 */
async function runTrendsJob(send, options = {}) {
  const run = createRunContext('trends');

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

    // ---- Login Verification ----
    let loggedIn = false;
    if (savedSession) {
      try {
        log(send, 'session', 'Checking saved session validity on seller portal...');
        const checkUrl = settings.SELLER_INSIGHTS_URL || 'https://seller.flipkart.com/index.html#dashboard/growth/seller-insights';
        await awaitCancellable(run, page.goto(checkUrl, { waitUntil: 'domcontentloaded' }));
        await awaitCancellable(run, page.waitForTimeout(4000));

        const currentUrl = page.url();
        const hasDashboard = currentUrl.includes('#dashboard');
        const hasPassword = await page.locator('input[type="password"]').count().catch(() => 0);

        if (hasDashboard && hasPassword === 0) {
          loggedIn = true;
          log(send, 'session', `Saved session is active (${currentUrl}) — skipping login form.`);
        } else {
          warn(send, 'session', `Saved session not active (landed on ${currentUrl}) — initiating fresh login.`);
        }
      } catch (checkErr) {
        if (run.cancelled) throw checkErr;
        warn(send, 'session', `Saved session check failed (${checkErr.message}) — initiating fresh login.`);
      }
    }

    if (!loggedIn) {
      log(send, 'login', 'Initiating Flipkart seller login flow...');
      await awaitCancellable(run, login(page, send));
      await awaitCancellable(run, saveSession(context, send));
    }

    // Determine target verticals & pages
    const pagesPerVertical = Math.max(1, parseInt(options.pages, 10) || settings.TRENDS_PAGES_PER_VERTICAL || 10);
    const selectedVertical = options.vertical && options.vertical !== 'all' ? options.vertical : null;

    const targets = selectedVertical
      ? { [selectedVertical]: VERTICALS[selectedVertical] || selectedVertical }
      : VERTICALS;

    const targetEntries = Object.entries(targets);
    log(send, 'trends', `Starting Search Trends scraping for ${targetEntries.length} vertical(s) (${pagesPerVertical} pages each)...`);

    const today = todayIST();
    let totalPushed = 0;
    let verticalsProcessed = 0;
    const results = [];

    for (const [slug, label] of targetEntries) {
      if (run.cancelled) throw new RunCancelledError();

      log(send, 'trends', `========================================`);
      log(send, 'trends', `Vertical [${verticalsProcessed + 1}/${targetEntries.length}]: ${label}`);
      log(send, 'trends', `========================================`);

      const rows = await scrapeVertical(page, send, run, slug, pagesPerVertical);
      const pushed = await awaitCancellable(run, pushTrends(rows, label, today, send));

      totalPushed += pushed;
      verticalsProcessed += 1;
      results.push({ vertical: label, slug, rowsScraped: rows.length, rowsPushed: pushed });

      log(send, 'trends', `Completed '${label}': ${rows.length} rows scraped, ${pushed} rows pushed.`);
      await page.waitForTimeout(1000);
    }

    log(send, 'trends', `All done! ${verticalsProcessed}/${targetEntries.length} vertical(s) processed, ${totalPushed} total row(s) pushed to Google Sheet.`);
    return {
      rowsAdded: totalPushed,
      verticalsProcessed,
      results,
    };
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

module.exports = {
  VERTICALS,
  scrapeVertical,
  runTrendsJob,
};
