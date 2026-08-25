/**
 * Wallet page automation: navigate, select a date, download the report.
 */
const path = require('path');
const { settings } = require('./config');
const { WalletSelectors } = require('./selectors');
const { log, warn, humanPause, stepPause, safeClick, screenshotOnError } = require('./utils');
const { MONTH_NAMES, MONTH_ABBRS, monthOrdinal } = require('./dateUtil');

const WALLET_URL_MARKER = 'wallet/summary';

// Promotional popups ("Exclusive Ad Credit Bonus Plan" and similar upsells)
// rotate their copy over time, so matching today's exact wording is a
// losing battle — these match on common close affordances instead, in
// priority order (most specific first).
const CLOSE_SELECTORS = [
  WalletSelectors.MODAL_CLOSE_BUTTON,
  '[role="dialog"] button:has-text("Close")',
  '[aria-label="close" i]',
  '[aria-label*="close" i]',
  'button:has-text("Close")',
  'button:has-text("×")', // ×
  'button:has-text("✕")', // ✕
  'button:has-text("Not now")',
  'button:has-text("Maybe later")',
  'button:has-text("No thanks")',
  WalletSelectors.TOUR_SKIP_BUTTON,
];

// Instant "is this on screen right now?" check. Deliberately NOT
// waitVisibleQuick: that blocks for its full timeout on every miss, and
// this runs across a dozen selectors several times per page — the waiting
// version turned overlay cleanup into a ~1 minute stall per call.
async function isVisibleNow(page, selector) {
  try {
    const loc = page.locator(selector).first();
    if ((await loc.count()) === 0) return false;
    return await loc.isVisible();
  } catch {
    return false;
  }
}

// Clicks the target and reports success only if it actually made that
// specific element go away. Needed because a genuine "Skip to main content"
// accessibility link matches the loose Skip selector but only performs an
// in-page anchor jump — without this check it looks like progress every
// round forever. The handle is captured before the click so re-resolving
// the selector to a *different* matching element can't fake a success.
async function tryClick(page, send, step, selector, successMessage) {
  try {
    const loc = page.locator(selector).first();
    if (!(await isVisibleNow(page, selector))) return false;
    const handle = await loc.elementHandle();
    if (!handle) return false;
    await humanPause(send, step, 80, 200);
    await loc.click({ timeout: 3000 });
    await page.waitForTimeout(250);
    const stillVisible = await handle.isVisible().catch(() => false);
    if (stillVisible) return false; // clicking it didn't actually dismiss anything
    log(send, step, successMessage);
    return true;
  } catch {
    return false;
  }
}

// Forcibly removes any lingering overlay-looking element: fixed or
// absolute-positioned, sizeable relative to the viewport, and either a
// dialog role or a meaningful z-index. Last resort for when nothing has an
// identifiable "Close" affordance to click.
async function forceRemoveOverlays(page, send) {
  const step = 'wallet.dismiss_overlays.force';
  const removed = await page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let count = 0;
    for (const el of document.querySelectorAll('body *')) {
      if (el === document.body || el.id === 'app' || el.id === 'root') continue;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (style.position !== 'fixed' && style.position !== 'absolute') continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < vw * 0.3 || rect.height < vh * 0.2) continue;

      const zIndex = parseInt(style.zIndex, 10);
      const role = el.getAttribute('role');
      const looksLikeOverlay =
        (Number.isFinite(zIndex) && zIndex >= 5) || role === 'dialog' || role === 'alertdialog';
      if (!looksLikeOverlay) continue;

      // The date-picker dropdown is itself absolutely positioned, large and
      // high z-index, so it matches every test above — never destroy the
      // very control the run depends on. Calendars are <table>s and the
      // panel carries a Done button; promo popups have neither.
      if (el.querySelector('table')) continue;
      if (/\bDone\b/.test(el.textContent || '') && el.querySelector('td, table')) continue;

      el.remove();
      count += 1;
    }
    return count;
  });
  if (removed > 0) {
    warn(send, step, `Force-removed ${removed} lingering overlay element(s) with no identifiable Close button`);
  }
  return removed;
}

/**
 * Clear anything covering the page. Overlays can stack (dismissing one
 * reveals the next), so this sweeps repeatedly until a round finds nothing
 * left to close.
 *
 * settleMs waits once up front for a popup to animate in; after that every
 * check is instant, so a page with no popups costs ~1s total rather than
 * the ~60s the timeout-per-selector version did.
 */
async function dismissOverlays(page, send, { maxRounds = 6, settleMs = 700, force = true } = {}) {
  const step = 'wallet.dismiss_overlays';
  await page.waitForTimeout(settleMs);

  for (let round = 0; round < maxRounds; round += 1) {
    let dismissed = false;
    for (const selector of CLOSE_SELECTORS) {
      if (await tryClick(page, send, step, selector, `Dismissed overlay (${selector})`)) {
        dismissed = true;
        break; // something changed — re-scan from the top of the list
      }
    }

    if (dismissed) {
      await page.waitForTimeout(250); // let the next one animate in, if any
      continue;
    }

    // Nothing had a Close/Skip affordance we could find. Get rid of whatever
    // is still blocking rather than getting stuck here.
    if (!force) return;
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
    if ((await forceRemoveOverlays(page, send)) === 0) return; // truly nothing left
  }
}

// The ads-wallet widget occasionally shows its own "Something went wrong /
// Refresh" error on a transient data-load hiccup. Click through it before
// giving up on finding the date picker.
async function recoverFromWidgetError(page, send, maxAttempts = 3) {
  const step = 'wallet.recover';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const refreshBtn = page.getByText('Refresh', { exact: true }).first();
    let visible;
    try {
      visible = await refreshBtn.isVisible();
    } catch {
      return;
    }
    if (!visible) return;
    warn(send, step, `Wallet widget errored — clicking Refresh (attempt ${attempt}/${maxAttempts})`);
    await refreshBtn.click();
    await page.waitForTimeout(4000);
  }
}

async function navigateToWallet(page, send) {
  const step = 'wallet.navigate';

  log(send, step, `Navigating to ${settings.WALLET_URL}`);
  await page.goto(settings.WALLET_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: settings.PAGE_LOAD_TIMEOUT_MS });
  await stepPause(send, step);

  // The seller-hub SPA sometimes bounces a fresh hash deep-link back to the
  // generic dashboard home while it finishes bootstrapping auth, instead of
  // landing on the wallet page. Re-navigating once it's settled fixes it.
  if (!page.url().includes(WALLET_URL_MARKER)) {
    warn(send, step, `Redirected away from wallet page (current URL: ${page.url()}) — retrying navigation`);
    await page.waitForTimeout(2000);
    await page.goto(settings.WALLET_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: settings.PAGE_LOAD_TIMEOUT_MS });
    await stepPause(send, step);

    if (!page.url().includes(WALLET_URL_MARKER)) {
      throw new Error(`[${step}] Could not land on wallet summary page — still redirected to: ${page.url()}`);
    }
  }

  await dismissOverlays(page, send);
  await recoverFromWidgetError(page, send);
  // The widget reload above can trigger a fresh guided-tour tooltip that
  // didn't exist at the first dismiss pass — sweep again.
  await dismissOverlays(page, send);

  log(send, step, `Wallet page loaded — current URL: ${page.url()}`);
}

// True once the calendar panel is actually on screen, so a failed trigger
// click surfaces as a clear error instead of a confusing downstream one.
async function isPickerOpen(page) {
  return (await isVisibleNow(page, WalletSelectors.CUSTOM_DONE_XPATH))
    || (await isVisibleNow(page, WalletSelectors.CUSTOM_DONE_FALLBACK))
    || (await isVisibleNow(page, '(//table[contains(@class, "__MonthWrapper-sc-")])[1]'));
}

// Reads whatever the date-range control currently displays ("Last 30 days :
// 26-Jul-26 - 25-Aug-26", "Yesterday : 24-Aug-26", ...) for verification.
async function readDateDisplay(page) {
  try {
    const loc = page.locator(WalletSelectors.DATE_PICKER_TRIGGER_XPATH).first();
    if ((await loc.count()) === 0) return '';
    return (await loc.innerText()).replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

// Commits the picker selection. The "Yesterday" preset was previously
// assumed to auto-apply, but the panel keeps a Done button for every path
// and the selection doesn't stick without it — so always confirm.
async function clickDone(page, send, step) {
  for (const selector of [WalletSelectors.CUSTOM_DONE_XPATH, WalletSelectors.CUSTOM_DONE_FALLBACK]) {
    if (await isVisibleNow(page, selector)) {
      await humanPause(send, step, 150, 350);
      await page.locator(selector).first().click({ timeout: 5000 });
      log(send, step, "Clicked 'Done' to apply the selection");
      await page.waitForTimeout(600);
      return true;
    }
  }
  warn(send, step, "No 'Done' button found — assuming the selection auto-applied");
  return false;
}

/**
 * Open the date picker and select targetDate ({y,m,d}).
 * Yesterday goes through the "Yesterday" preset. Any other (older) date is
 * a backfill and goes through the custom dual calendar. Either way the
 * selection is committed with Done.
 */
async function selectDate(page, send, targetDate, isYesterday) {
  const step = 'wallet.date_select';
  const label = `${String(targetDate.d).padStart(2, '0')}-${MONTH_ABBRS[targetDate.m]}-${targetDate.y}`;

  // Runs before the picker is opened, so force-removal can't race with the
  // panel being on screen.
  await dismissOverlays(page, send);

  log(send, `${step}.open`, `Opening date picker for ${label}`);
  await safeClick(page, WalletSelectors.DATE_PICKER_TRIGGER_XPATH, WalletSelectors.DATE_PICKER_TRIGGER_FALLBACK,
    `${step}.open`, send);
  await page.waitForTimeout(1200);

  if (!(await isPickerOpen(page))) {
    // One retry: a stray overlay can swallow the first click.
    warn(send, `${step}.open`, 'Date picker did not open on the first click — retrying once');
    await dismissOverlays(page, send, { settleMs: 200 });
    await safeClick(page, WalletSelectors.DATE_PICKER_TRIGGER_XPATH, WalletSelectors.DATE_PICKER_TRIGGER_FALLBACK,
      `${step}.open`, send);
    await page.waitForTimeout(1200);
    if (!(await isPickerOpen(page))) {
      throw new Error(`[${step}.open] Date picker did not open for ${label}`);
    }
  }
  log(send, `${step}.open`, 'Date picker is open');

  if (isYesterday) {
    log(send, `${step}.yesterday`, "Selecting 'Yesterday'");
    await safeClick(page, WalletSelectors.YESTERDAY_OPTION_XPATH, WalletSelectors.YESTERDAY_OPTION_FALLBACK,
      `${step}.yesterday`, send);
    await page.waitForTimeout(600);
  } else {
    await selectCustomDate(page, send, targetDate);
  }

  await clickDone(page, send, `${step}.done`);

  log(send, `${step}.wait`, `Waiting ${settings.DATA_LOAD_WAIT_MS}ms for data to load`);
  await page.waitForTimeout(settings.DATA_LOAD_WAIT_MS);
  await page.waitForLoadState('networkidle', { timeout: settings.PAGE_LOAD_TIMEOUT_MS }).catch(() => {});

  // Verify rather than assume: a silently-unapplied selection would
  // otherwise download the wrong date's report and push it under the right
  // date's label in the sheet — corrupt data that looks correct.
  const display = await readDateDisplay(page);
  const shortLabel = `${String(targetDate.d).padStart(2, '0')}-${MONTH_ABBRS[targetDate.m]}-${String(targetDate.y).slice(-2)}`;
  if (display && !display.includes(shortLabel) && !display.includes(label)) {
    warn(send, step, `Date control reads "${display}" — expected it to show ${shortLabel}. Continuing, but the downloaded report may not match.`);
  } else if (display) {
    log(send, step, `Date control now reads "${display}"`);
  }

  log(send, step, `Date selection complete — ${label}`);
}

async function readSide(page, monthBadge, yearBadge) {
  const monthTxt = (await page.locator(monthBadge).first().innerText()).trim();
  const yearTxt = (await page.locator(yearBadge).first().innerText()).trim();
  let monthNum = MONTH_NAMES.indexOf(monthTxt);
  if (monthNum < 0) {
    const abbr = monthTxt.slice(0, 3);
    const titled = abbr[0].toUpperCase() + abbr.slice(1).toLowerCase();
    monthNum = MONTH_ABBRS.indexOf(titled);
  }
  if (monthNum < 0) {
    throw new Error(`Unrecognised calendar month label: ${monthTxt}`);
  }
  return Number(yearTxt) * 12 + monthNum;
}

/**
 * Page the dual calendar until targetDate's month is visible.
 * Returns the calendar index showing it (1 = left, 2 = right).
 */
async function bringDateIntoView(page, send, targetDate, maxSteps = 24) {
  const step = 'wallet.date_select.custom.month';
  const targetOrd = monthOrdinal(targetDate);

  for (let i = 0; i < maxSteps; i += 1) {
    const leftOrd = await readSide(page, WalletSelectors.LEFT_CAL_MONTH_BADGE, WalletSelectors.LEFT_CAL_YEAR_BADGE);
    const rightOrd = await readSide(page, WalletSelectors.RIGHT_CAL_MONTH_BADGE, WalletSelectors.RIGHT_CAL_YEAR_BADGE);

    if (targetOrd === leftOrd) {
      log(send, step, 'Target month in left calendar');
      return 1;
    }
    if (targetOrd === rightOrd) {
      log(send, step, 'Target month in right calendar');
      return 2;
    }

    let arrow;
    let where;
    if (targetOrd < leftOrd) {
      arrow = WalletSelectors.LEFT_CAL_PREV_ARROW;
      where = 'left-cal prev';
    } else {
      arrow = WalletSelectors.RIGHT_CAL_NEXT_ARROW;
      where = 'right-cal next';
    }
    log(send, step,
      `Calendars show ${Math.floor(leftOrd / 12)}-${String(leftOrd % 12).padStart(2, '0')} / ` +
      `${Math.floor(rightOrd / 12)}-${String(rightOrd % 12).padStart(2, '0')}; clicking ${where}`);
    await safeClick(page, arrow, null, step, send);
    await page.waitForTimeout(500);
  }

  throw new Error(`[${step}] Could not page the calendar into view within ${maxSteps} steps`);
}

/**
 * Select one specific past date from the always-visible dual calendar.
 * There is no "Custom" button — page the correct month into view, then click
 * its day cell twice (range start then end == same day). Committing with
 * "Done" is left to the caller, which does it for every path.
 */
async function selectCustomDate(page, send, targetDate) {
  const step = 'wallet.date_select.custom';

  const calIndex = await bringDateIntoView(page, send, targetDate);

  const dayXPath = WalletSelectors.dayCellXPath(targetDate.d, calIndex);
  for (const clickNo of [1, 2]) {
    log(send, `${step}.day`, `Clicking day ${targetDate.d} in calendar ${calIndex} (click ${clickNo}/2)`);
    await safeClick(page, dayXPath, null, `${step}.day`, send);
    await page.waitForTimeout(400);
  }
}

const MONTHS_3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

async function downloadWalletReport(page, send, targetDate) {
  const step = 'wallet.download';
  const dateStr = `${String(targetDate.d).padStart(2, '0')}-${MONTHS_3[targetDate.m - 1]}-${targetDate.y}`;

  log(send, step, `Starting download for ${dateStr}`);
  await humanPause(send, `${step}.click`);

  // The download icon sits immediately to the right of the date-range
  // control, on the same row. Anchoring the search to that control's live
  // position — rather than the hardcoded viewport pixel ranges this used
  // before — keeps it working across window sizes and layout tweaks.
  const iconHandle = await page.evaluateHandle(() => {
    const isShown = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    let dateEl = document.querySelector('div.date[role="presentation"]');
    if (!dateEl || !isShown(dateEl)) {
      dateEl = [...document.querySelectorAll('*')].find((el) => {
        const t = (el.textContent || '').trim();
        return el.children.length === 0
          && isShown(el)
          && /(Yesterday|Today|Custom|Last\s+\d+\s+days)\s*:/i.test(t);
      });
    }

    if (dateEl) {
      const dateRect = dateEl.getBoundingClientRect();
      const clickable = [...document.querySelectorAll('svg, button, [role="button"], a, img, i')];
      const toTheRight = clickable
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ el, r }) => {
          if (r.width === 0 || r.height === 0) return false;
          if (r.width > 90 || r.height > 90) return false;   // an icon, not a panel
          if (el.contains(dateEl) || dateEl.contains(el)) return false;
          if (r.left < dateRect.right - 4) return false;      // must be to the right
          const overlap = Math.min(r.bottom, dateRect.bottom) - Math.max(r.top, dateRect.top);
          return overlap > Math.min(r.height, dateRect.height) * 0.4; // same row
        })
        .sort((a, b) => a.r.left - b.r.left);
      if (toTheRight.length > 0) return toTheRight[0].el; // nearest icon to its right
    }

    // Explicit download affordances, if the site ever labels them.
    const labelled = [...document.querySelectorAll(
      '[class*="download" i], [aria-label*="download" i], [title*="download" i]'
    )].filter(isShown);
    if (labelled.length > 0) return labelled[0];

    return null;
  });

  const downloadIcon = iconHandle ? iconHandle.asElement() : null;
  if (!downloadIcon) {
    await screenshotOnError(page, step, send);
    throw new Error('[wallet.download] Could not locate the download icon next to the date control');
  }

  log(send, `${step}.click`, 'Clicking download icon');

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: settings.DOWNLOAD_TIMEOUT_MS }),
    downloadIcon.click(),
  ]);

  const suggested = download.suggestedFilename();
  const originalExt = path.extname(suggested) || '.csv';

  log(send, step, `Download received: ${suggested}`);

  let targetName = `${dateStr}${originalExt}`;
  let targetPath = path.join(settings.DOWNLOAD_DIR, targetName);

  require('fs').mkdirSync(settings.DOWNLOAD_DIR, { recursive: true });
  if (require('fs').existsSync(targetPath)) {
    const ts = Date.now();
    targetName = `${dateStr}_${ts}${originalExt}`;
    targetPath = path.join(settings.DOWNLOAD_DIR, targetName);
    warn(send, step, `File already exists, saving as ${targetName}`);
  }

  await download.saveAs(targetPath);
  log(send, step, `Report saved as ${targetPath}`);
  return targetPath;
}

module.exports = { navigateToWallet, selectDate, downloadWalletReport, dismissOverlays, WALLET_URL_MARKER };
