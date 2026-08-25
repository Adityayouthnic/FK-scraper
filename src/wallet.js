/**
 * Wallet page automation: navigate, select a date, download the report.
 */
const path = require('path');
const { settings } = require('./config');
const { WalletSelectors } = require('./selectors');
const { log, warn, humanPause, stepPause, safeClick, waitVisibleQuick } = require('./utils');
const { MONTH_NAMES, MONTH_ABBRS, monthOrdinal } = require('./dateUtil');

const WALLET_URL_MARKER = 'wallet/summary';

// Promotional popups ("Exclusive Ad Credit Bonus Plan" and similar upsells)
// rotate their copy over time, so matching today's exact wording is a
// losing battle — these match on common close affordances instead, tried
// in order from most to least specific.
const GENERIC_CLOSE_PATTERNS = [
  '[aria-label="close" i]',
  '[role="dialog"] button:has-text("Close")',
  'button:has-text("Close")',
  '[aria-label*="close" i]',
  'button:has-text("×")', // ×
  'button:has-text("✕")', // ✕
  'button:has-text("Not now")',
  'button:has-text("Maybe later")',
  'button:has-text("No thanks")',
];

// Clicks the target and reports success only if it actually made the
// element go away. This matters for things like a genuine "Skip to main
// content" accessibility link elsewhere on the page, which the loose Skip
// selector can match: clicking it just does an in-page anchor jump and the
// link stays put, so without this check it would look like "progress" every
// round forever and the loop would never terminate on its own.
async function tryClick(page, send, step, selector, timeoutMs, successMessage) {
  try {
    const loc = page.locator(selector).first();
    if (!(await waitVisibleQuick(page, selector, timeoutMs))) return false;
    await humanPause(send, step);
    await loc.click();
    await page.waitForTimeout(400);
    const stillVisible = await loc.isVisible().catch(() => false);
    if (stillVisible) return false; // clicking it didn't actually dismiss anything
    log(send, step, successMessage);
    return true;
  } catch {
    return false;
  }
}

// Forcibly removes any lingering full/large-overlay-looking element: fixed
// or absolute-positioned, sizeable relative to the viewport, and either a
// dialog role or a meaningful z-index. Last resort for when nothing has an
// identifiable "Close" affordance to click — never touches the page's own
// root containers.
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

// Overlays can stack (a promo popup on top of another), and dismissing one
// can reveal the next, so this sweeps repeatedly until nothing is left to
// close instead of assuming a single pass is enough. Every candidate is
// tried every round — an earlier match (e.g. a loosely-matching "Skip"
// selector catching unrelated text elsewhere on the page) must never skip
// the rest of the sweep, or a real popup's Close button can be missed
// entirely while something irrelevant gets clicked instead.
async function dismissOverlays(page, send, maxRounds = 5) {
  const step = 'wallet.dismiss_overlays';

  for (let round = 0; round < maxRounds; round += 1) {
    let dismissedCount = 0;

    if (await tryClick(page, send, step, WalletSelectors.MODAL_CLOSE_BUTTON, 1200, 'Dismissed modal dialog')) {
      dismissedCount += 1;
    }
    if (await tryClick(page, send, step, WalletSelectors.TOUR_SKIP_BUTTON, 1200, 'Skipped guided tour')) {
      dismissedCount += 1;
    }
    for (const pattern of GENERIC_CLOSE_PATTERNS) {
      if (await tryClick(page, send, step, pattern, 800, `Dismissed a popup (close match: ${pattern})`)) {
        dismissedCount += 1;
        break; // one generic match per round is enough; the next round re-scans
      }
    }

    if (dismissedCount > 0) continue; // something changed — re-scan from the top

    // Nothing had a Close/Skip affordance we could find. Per your ask: get
    // rid of whatever's still blocking rather than getting stuck here.
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
    const forceRemoved = await forceRemoveOverlays(page, send);
    if (forceRemoved === 0) break; // truly nothing left to do
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

/**
 * Open the date picker and select targetDate ({y,m,d}).
 * Yesterday goes through the reliable "Yesterday" preset. Any other (older)
 * date is a backfill and goes through the custom dual calendar.
 */
async function selectDate(page, send, targetDate, isYesterday) {
  const step = 'wallet.date_select';

  await dismissOverlays(page, send);

  log(send, `${step}.open`, `Opening date picker for ${targetDate.d}-${MONTH_ABBRS[targetDate.m]}-${targetDate.y}`);
  await safeClick(page, WalletSelectors.DATE_PICKER_TRIGGER_XPATH, WalletSelectors.DATE_PICKER_TRIGGER_FALLBACK,
    `${step}.open`, send);

  await page.waitForTimeout(1500);

  if (isYesterday) {
    log(send, `${step}.yesterday`, "Selecting 'Yesterday'");
    await safeClick(page, WalletSelectors.YESTERDAY_OPTION_XPATH, WalletSelectors.YESTERDAY_OPTION_FALLBACK,
      `${step}.yesterday`, send);
    await stepPause(send, `${step}.yesterday`);
  } else {
    await selectCustomDate(page, send, targetDate);
  }

  log(send, `${step}.wait`, `Waiting ${settings.DATA_LOAD_WAIT_MS}ms for data to load`);
  await page.waitForTimeout(settings.DATA_LOAD_WAIT_MS);

  log(send, step, `Date selection complete — ${targetDate.d}-${MONTH_ABBRS[targetDate.m]}-${targetDate.y}`);
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
 * There is no "Custom" button — page the correct month into view, click its
 * day cell twice (range start then end == same day), then "Done".
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

  log(send, `${step}.done`, "Clicking 'Done'");
  await safeClick(page, WalletSelectors.CUSTOM_DONE_XPATH, WalletSelectors.CUSTOM_DONE_FALLBACK, `${step}.done`, send);
  await stepPause(send, step);
}

const MONTHS_3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

async function downloadWalletReport(page, send, targetDate) {
  const step = 'wallet.download';
  const dateStr = `${String(targetDate.d).padStart(2, '0')}-${MONTHS_3[targetDate.m - 1]}-${targetDate.y}`;

  log(send, step, `Starting download for ${dateStr}`);
  await humanPause(send, `${step}.click`);

  // Locate the download icon by inspecting the DOM: it's the element
  // immediately after the date display area ("Yesterday : 12-May-26" or
  // similar), with a small-SVG fallback heuristic if that structure moves.
  const monthChecks = MONTHS_3.map((m) => `t.includes('-${m}-')`).join(' || ');
  const iconHandle = await page.evaluateHandle(`
    (() => {
        const allEls = [...document.querySelectorAll('*')];
        const dateEl = allEls.find(el => {
            const t = el.textContent || '';
            return (t.includes('Yesterday') || t.includes('Custom'))
                && (${monthChecks})
                && el.children.length === 0
                && el.offsetWidth > 0;
        });

        if (dateEl) {
            let container = dateEl.parentElement;
            for (let i = 0; i < 5; i++) {
                if (!container) break;
                const next = container.nextElementSibling;
                if (next) {
                    const svg = next.querySelector('svg') || next;
                    if (svg.offsetWidth > 0 && svg.offsetWidth < 100) return svg;
                }
                container = container.parentElement;
            }
        }

        const svgs = [...document.querySelectorAll('svg')];
        const candidates = svgs.filter(svg => {
            const rect = svg.getBoundingClientRect();
            return rect.right > 1100 && rect.width < 60 && rect.height < 60
                && rect.top > 300 && rect.top < 500;
        });
        if (candidates.length > 0) return candidates[candidates.length - 1];

        return null;
    })()
  `);

  const downloadIcon = iconHandle ? iconHandle.asElement() : null;
  if (!downloadIcon) {
    throw new Error('[wallet.download] Could not locate download icon');
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
