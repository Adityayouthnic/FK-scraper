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
 *
 * Runs inside the persistent Live URL session — login happens only once.
 */
const { settings } = require('./config');
const { pushTrends, isVerticalAlreadyPresent } = require('./trendsSheets');
const { log, warn, humanPause } = require('./utils');
const { todayIST } = require('./dateUtil');
const {
  RunCancelledError,
  awaitCancellable,
  createRunContext,
  setupScreencast,
  stopScreencast,
  clearActiveRun,
} = require('./runner');
const {
  getOrCreateLiveSession,
  ensureAuthenticated,
  markSessionUnauthenticated,
} = require('./sessionManager');

// slug (used in the page URL) -> display label (matches the sheet's existing casing)
const VERTICALS = {
  women_ethnic_set: 'Women Ethnic Set',
  women_sari: 'Women Sari',
  Women_Kurta_And_Kurti: 'Women Kurta And Kurti',
};

/**
 * In-browser evaluation function to extract rows from Flipkart's Search Trends table.
 * Uses both specific class names and semantic fallbacks so styled-components hash changes
 * won't break extraction.
 */
function extractTrendsRows() {
  const table = document.querySelector('table[data-testid="grid-component"]');
  if (!table) return [];
  const rows = [...table.querySelectorAll('tbody tr')];
  return rows.map((tr) => {
    const tds = tr.querySelectorAll('td');
    if (tds.length < 6) return null;

    // Col 0: Searched Term
    const termEl =
      tds[0].querySelector('[class*="ProdTitle"]') ||
      tds[0].querySelector('span') ||
      tds[0];
    const term = termEl ? termEl.textContent.trim() : '';

    // Col 2: Weekly search volume & % change
    const volEl =
      tds[2].querySelector('[class*="VolumeValue"]') ||
      tds[2].querySelector('span') ||
      tds[2];
    const volume = volEl ? volEl.textContent.trim() : '';

    const arrowEl =
      tds[2].querySelector('[class*="ArrowIcon"]') ||
      tds[2].querySelector('svg') ||
      tds[2].querySelector('span:last-child');
    const change = arrowEl ? arrowEl.textContent.trim() : '';

    // Col 3: CTR%
    const ctrEl =
      tds[3].querySelector('[class*="CtrCell"]') ||
      tds[3].querySelector('span') ||
      tds[3];
    const ctr = ctrEl ? ctrEl.textContent.trim() : '';

    // Col 4: Units Sold
    const unitsEl =
      tds[4].querySelector('[class*="CtrCell"]') ||
      tds[4].querySelector('span') ||
      tds[4];
    const units = unitsEl ? unitsEl.textContent.trim() : '';

    // Col 5: No. of Products Shown
    const productsEl =
      tds[5].querySelector('[class*="CtrCell"]') ||
      tds[5].querySelector('span') ||
      tds[5];
    const products = productsEl ? productsEl.textContent.trim() : '';

    return { term, volume, change, ctr, units, products };
  }).filter(Boolean);
}

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
    await awaitCancellable(run, page.waitForLoadState('networkidle', { timeout: 15000 }));
  } catch {
    // networkidle is best-effort
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

    const rawRows = await awaitCancellable(run, page.evaluate(extractTrendsRows));
    const rows = Array.isArray(rawRows) ? rawRows : [];
    log(send, step, `Page ${pageNum}/${pagesToScrape} for '${verticalLabel}': extracted ${rows.length} rows`);

    if (rows.length === 0) {
      log(send, step, `No rows found on page ${pageNum}. Ending extraction for '${verticalLabel}'.`);
      break;
    }

    allRows.push(...rows);

    if (pageNum < pagesToScrape) {
      const firstTermBefore = rows[0].term;
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
                'table[data-testid="grid-component"] tbody tr td [class*="ProdTitle"], table[data-testid="grid-component"] tbody tr td'
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
 * Runs in the persistent live browser session — login occurs only once.
 */
async function runTrendsJob(send, options = {}) {
  const run = createRunContext('trends');

  let client = null;
  let page = null;
  let context = null;

  try {
    const sessionInfo = await getOrCreateLiveSession(send, run);
    page = sessionInfo.page;
    context = sessionInfo.context;

    // Attach real-time screencast so the user sees the live session immediately
    client = await setupScreencast(run, context, page, send);

    // Verify authentication: if already logged in, skips login immediately; if not, performs login
    await ensureAuthenticated(page, context, send, run, sessionInfo, options);

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

      // Pre-check: skip if data for this vertical on today's date is already recorded in the sheet
      const alreadyPresent = await awaitCancellable(run, isVerticalAlreadyPresent(label, today, send));
      if (alreadyPresent) {
        log(
          send,
          'trends',
          `'${label}' already has data recorded in Google Sheets for today (${today.m}/${today.d}/${today.y}). Skipping to prevent duplication.`
        );
        verticalsProcessed += 1;
        results.push({ vertical: label, slug, rowsScraped: 0, rowsPushed: 0, skipped: true });
        continue;
      }

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
    // On unexpected failure (e.g. grid timeout due to session drop), mark unauthenticated
    // so the next run re-authenticates rather than assuming the session is still good
    markSessionUnauthenticated();
    throw err;
  } finally {
    await stopScreencast(client);
    // Keep the live browser & page open in memory for future runs and verticals!
    run.resolveCancel();
    clearActiveRun(run);
  }
}

module.exports = {
  VERTICALS,
  scrapeVertical,
  runTrendsJob,
};
