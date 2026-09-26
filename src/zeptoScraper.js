/**
 * Pure Node.js Playwright Scraper & Pipeline for Zepto
 *
 * Implements:
 *  - Unattended browser login with automatic IMAP OTP resolution
 *  - Real-time CDP screencasting to live canvas view
 *  - Interactive input dispatching & instant user cancellation
 *  - Report request & polling engine (reusing completed reports or generating anew)
 *  - Direct presigned S3 download bypass (eliminating OS download dialog crashes)
 *  - Full integration with Google Sheets pipeline (Sales gap-filling & Inventory snapshot)
 *  - Failure alerts over Webhook and SMTP
 *
 * ZERO PYTHON DEPENDENCY — 100% native Node.js.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { getRawZeptoCredentials } = require('./credentials');
const { log, warn } = require('./utils');
const {
  RunCancelledError,
  createRunContext,
  clearActiveRun,
  setActivePage,
  clearActivePage,
  setupScreencast,
  stopScreencast,
  awaitCancellable,
} = require('./runner');
const { fetchZeptoOtp } = require('./zeptoOtp');
const {
  loadLookups,
  getExistingSalesDates,
  getMissingSalesDates,
  transformSalesCsv,
  appendSalesData,
  refreshInventoryData,
  formatSheetDate,
  parseAnyDate,
} = require('./zeptoSheets');
const { getSheetsClient } = require('./googleAuth');
const { sendZeptoAlert } = require('./zeptoNotify');
const { sendAlert } = require('./alerts');

const BASE_URL = 'https://brands.zepto.co.in';
const LOGIN_URL = `${BASE_URL}/login`;
const REPORTS_URL = `${BASE_URL}/vendor/reports`;

const AUTH_PATHS = ['/login', '/forgot-password', '/otp', '/verify', '/two-factor'];
const PUBLIC_PATHS = ['/zepto', '/register', '/contact-us'];

const DATELESS_TYPES = new Set(['vendorinventoryf', 'deqinventory']);
const TABLE_DATE_RE = /\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}/g;

/**
 * Returns path to local persistent browser profile.
 */
function getProfileDir() {
  const localDir = path.join(__dirname, '..', 'secrets', 'zepto_profile');
  if (!fs.existsSync(localDir)) {
    try {
      fs.mkdirSync(localDir, { recursive: true });
    } catch {}
  }
  return localDir;
}

/**
 * Formats a Date object to mm/dd/yyyy (portal input format).
 */
function formatPortalDate(d) {
  if (!d || isNaN(d.getTime())) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

/**
 * Normalizes text for lenient matching.
 */
function normalizeText(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Matches report dropdown types with table badges.
 */
function typeMatches(cellType, reportType) {
  const a = normalizeText(cellType);
  const b = normalizeText(reportType);
  if (a.length < 4 || b.length < 4) return false;
  return a.includes(b) || b.includes(a);
}

/**
 * Checks if report type is a dateless stock snapshot.
 */
function isDateless(reportType) {
  return DATELESS_TYPES.has(normalizeText(reportType));
}

/**
 * Extracts and parses dates like "12 Aug 2026" from table cell text.
 */
function parseTableDates(text) {
  const matches = String(text || '').match(TABLE_DATE_RE);
  if (!matches) return [];
  const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  return matches.map((m) => {
    const parts = m.trim().split(/\s+/);
    if (parts.length < 3) return null;
    const day = parseInt(parts[0], 10);
    const monStr = parts[1].slice(0, 3).toLowerCase();
    const yr = parseInt(parts[2], 10);
    const monIdx = monthNames.indexOf(monStr);
    return monIdx !== -1 ? new Date(yr, monIdx, day) : null;
  }).filter(Boolean);
}

/**
 * Compares table date range with requested from/to date strings.
 */
function rangeMatches(rangeCell, startStr, endStr) {
  const found = parseTableDates(rangeCell);
  if (found.length !== 2) return false;

  const sDate = parseAnyDate(startStr);
  const eDate = parseAnyDate(endStr);
  if (!sDate || !eDate) return false;

  const sameDay = (d1, d2) =>
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate();

  return sameDay(found[0], sDate) && sameDay(found[1], eDate);
}

/**
 * Checks if the report was requested today.
 */
function isRequestedToday(requestedAtCell) {
  const found = parseTableDates(requestedAtCell);
  if (!found.length) return false;
  const today = new Date();
  const d = found[0];
  return (
    d.getDate() === today.getDate() &&
    d.getMonth() === today.getMonth() &&
    d.getFullYear() === today.getFullYear()
  );
}

/**
 * Checks whether the current page is authenticated.
 */
async function isLoggedIn(page) {
  try {
    const currentUrl = page.url();
    const parsed = new URL(currentUrl);
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';

    if (AUTH_PATHS.includes(pathname) || PUBLIC_PATHS.includes(pathname) || pathname === '/') {
      return false;
    }

    const emailField = page.locator('input[placeholder="Email ID"]');
    const isEmailVisible = await emailField.isVisible({ timeout: 1500 }).catch(() => false);
    return !isEmailVisible;
  } catch {
    return false;
  }
}

/**
 * Locates OTP input box(es) in the authentication challenge.
 */
async function findOtpInput(page) {
  const notLogin = ":not(#email):not(#password):not([type='email']):not([type='password'])";
  const selectors = [
    "input[autocomplete='one-time-code']",
    `input[name*='otp' i]${notLogin}`,
    `input[placeholder*='otp' i]${notLogin}`,
    `input[type='tel']${notLogin}`,
    `input[inputmode='numeric']${notLogin}`,
    `input[maxlength='1']${notLogin}`,
  ];

  for (const sel of selectors) {
    try {
      const loc = page.locator(sel);
      const count = await loc.count();
      if (count > 0 && await loc.first().isVisible()) {
        return loc;
      }
    } catch {}
  }
  return null;
}

/**
 * Fills OTP digits into input and clicks confirm button.
 */
async function fillOtp(page, code, send = () => {}) {
  const field = await findOtpInput(page);
  if (!field) {
    throw new Error('OTP field vanished before it could be filled.');
  }

  const count = await field.count();
  if (count >= code.length) {
    for (let i = 0; i < code.length; i++) {
      await field.nth(i).fill(code[i]);
    }
  } else {
    await field.first().fill(code);
  }

  await page.waitForTimeout(1000);

  const buttonNames = ['Confirm', 'Verify', 'Submit', 'Continue', 'Log In'];
  for (const name of buttonNames) {
    try {
      const btn = page.getByRole('button', { name, exact: false });
      const btnCount = await btn.count();
      if (btnCount > 0 && await btn.first().isEnabled()) {
        log(send, `[zepto.auth] Clicking '${name}' to submit OTP...`);
        await btn.first().click();
        return;
      }
    } catch {}
  }

  log(send, '[zepto.auth] No submit button found; pressing Enter...');
  await field.last().press('Enter');
}

/**
 * Executes automated login with IMAP OTP resolution.
 */
async function autoLogin(page, creds, send = () => {}, run = null) {
  const email = creds.email;
  const password = creds.password;

  if (!email || !password) {
    throw new Error('ZEPTO_EMAIL and ZEPTO_PASSWORD must be configured in Settings.');
  }

  log(send, '[zepto.auth] Submitting credentials to Zepto portal...');
  if (run?.cancelled) throw new RunCancelledError();
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  if (run?.cancelled) throw new RunCancelledError();
  if (await isLoggedIn(page)) {
    log(send, '[zepto.auth] Already signed in.');
    return;
  }

  const emailInput = page.locator('input[placeholder="Email ID"]');
  const passwordInput = page.locator('input[placeholder="Password"]');
  await emailInput.fill(email);
  await passwordInput.fill(password);

  const submittedAt = Date.now();
  await page.getByRole('button', { name: 'Log In' }).click();

  // Poll for dashboard, OTP challenge, or credentials error
  let otpFound = false;
  for (let i = 0; i < 20; i++) {
    if (run?.cancelled) throw new RunCancelledError();
    await page.waitForTimeout(1500);

    if (await isLoggedIn(page)) {
      log(send, '[zepto.auth] Signed in — no OTP was required.');
      return;
    }

    const otpInput = await findOtpInput(page);
    if (otpInput) {
      otpFound = true;
      break;
    }

    const bodyText = (await page.innerText('body').catch(() => '')).toLowerCase();
    if (bodyText.includes('invalid credentials') || bodyText.includes('incorrect password')) {
      throw new Error('Zepto rejected sign-in: "Invalid Credentials provided". Verify ZEPTO_EMAIL and ZEPTO_PASSWORD in Settings.');
    }
  }

  if (run?.cancelled) throw new RunCancelledError();
  if (!otpFound) {
    throw new Error(`Neither dashboard nor OTP screen appeared (still on ${page.url()}).`);
  }

  log(send, '[zepto.auth] OTP challenge reached. Polling mailbox for verification code...');
  const code = await fetchZeptoOtp(
    {
      host: creds.imapHost,
      user: creds.imapUser,
      password: creds.imapPassword,
    },
    submittedAt,
    (msg) => log(send, msg),
    180000,
    () => run?.cancelled
  );

  if (run?.cancelled) throw new RunCancelledError();
  log(send, `[zepto.auth] Got ${code.length}-digit OTP from email. Entering into portal...`);
  await fillOtp(page, code, send);

  for (let i = 0; i < 15; i++) {
    if (run?.cancelled) throw new RunCancelledError();
    await page.waitForTimeout(1500);
    if (await isLoggedIn(page)) {
      log(send, '[zepto.auth] OTP accepted — successfully authenticated to Zepto!');
      return;
    }
  }

  throw new Error(`OTP submitted but sign-in was not confirmed (still on ${page.url()}).`);
}

/**
 * Ensures browser has an active authenticated session.
 */
async function ensureSession(page, creds, send = () => {}, run = null) {
  log(send, '[zepto.auth] Checking portal session status...');
  if (run?.cancelled) throw new RunCancelledError();
  await page.goto(REPORTS_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  if (run?.cancelled) throw new RunCancelledError();
  if (await isLoggedIn(page)) {
    log(send, '[zepto.auth] Active session verified.');
    return;
  }

  log(send, '[zepto.auth] Session expired or not logged in. Initiating automated sign-in...');
  await autoLogin(page, creds, send, run);

  if (run?.cancelled) throw new RunCancelledError();
  await page.goto(REPORTS_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
}

/**
 * Reads all rows from the Reports table.
 */
async function getTableRows(page) {
  try {
    return await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      return rows
        .map((r) => ({
          requested_at: (r.cells[0]?.innerText || '').trim(),
          request_id: (r.cells[1]?.innerText || '').trim(),
          type: (r.cells[2]?.innerText || '').trim(),
          range: (r.cells[3]?.innerText || '').trim(),
          status: (r.cells[4]?.innerText || '').trim(),
        }))
        .filter((r) => r.request_id);
    });
  } catch {
    return [];
  }
}

/**
 * Searches the table for a completed or generating report matching criteria.
 */
async function findExistingReport(page, reportType, startStr, endStr) {
  const rows = await getTableRows(page);
  for (const row of rows) {
    if (!typeMatches(row.type, reportType)) continue;
    if (row.status.includes('Failed')) continue;

    if (startStr && endStr) {
      if (!rangeMatches(row.range, startStr, endStr)) continue;
    } else {
      if (row.range.match(TABLE_DATE_RE)) continue;
      if (!isRequestedToday(row.requested_at)) continue;
    }
    return row;
  }
  return null;
}

/**
 * Fills a date into a MUI masked date box (mm/dd/yyyy).
 */
async function fillDateInput(page, which, value) {
  const box = page.locator("input[placeholder='mm/dd/yyyy']");
  const count = await box.count();
  const target = count >= 2
    ? box.nth(which === 'from' ? 0 : 1)
    : page.locator(`input[name='${which === 'from' ? 'startDate' : 'endDate'}']`).first();

  const digits = value.replace(/\D/g, '');

  async function checkLanded() {
    const val = (await target.inputValue()).trim();
    return digits.length > 0 && val.replace(/\D/g, '').includes(digits) ? val : '';
  }

  // 1. Keyboard digits
  try {
    await target.click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.type(digits, { delay: 100 });
    await page.waitForTimeout(500);
    const landed = await checkLanded();
    if (landed) return landed;
  } catch {}

  // 2. Keyboard formatted
  try {
    await target.click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.type(value, { delay: 100 });
    await page.waitForTimeout(500);
    const landed = await checkLanded();
    if (landed) return landed;
  } catch {}

  // 3. Native fill
  try {
    await target.fill(value);
    await page.waitForTimeout(500);
    const landed = await checkLanded();
    if (landed) return landed;
  } catch {}

  // 4. React setter evaluation
  try {
    await target.evaluate((el, v) => {
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
    await page.waitForTimeout(500);
    const landed = await checkLanded();
    if (landed) return landed;
  } catch {}

  throw new Error(`Failed to set ${which} date input to ${value}.`);
}

/**
 * Selects the report type in the MUI dropdown.
 */
async function pickReportType(page, reportType) {
  const combobox = page.locator("#reportType[role='combobox'], div[role='combobox']#reportType").first();
  await combobox.click();
  await page.waitForTimeout(1500);

  const locators = [
    () => page.getByRole('option', { name: reportType, exact: true }),
    () => page.locator("li[role='option']").filter({ hasText: reportType }),
    () => page.locator("ul[role='listbox'] li").filter({ hasText: reportType }),
    () => page.getByText(reportType, { exact: true }),
  ];

  for (const build of locators) {
    try {
      const loc = build();
      const count = await loc.count();
      if (count > 0 && await loc.first().isVisible()) {
        await loc.first().click();
        await page.waitForTimeout(1000);
        return;
      }
    } catch {}
  }

  throw new Error(`Could not find report type '${reportType}' in dropdown options.`);
}

/**
 * Submits a new report request via portal UI.
 */
async function requestReport(page, reportType, startStr = null, endStr = null, send = () => {}, run = null) {
  const span = startStr && endStr ? `: ${startStr} -> ${endStr}` : ' (snapshot — no date range)';
  log(send, `[zepto.rep] Requesting report '${reportType}'${span}...`);

  if (run?.cancelled) throw new RunCancelledError();
  await page.goto(REPORTS_URL, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 10; i++) {
    if (run?.cancelled) throw new RunCancelledError();
    await page.waitForTimeout(300);
  }

  const rowsBefore = await getTableRows(page);
  const idsBefore = new Set(rowsBefore.map((r) => r.request_id));

  if (run?.cancelled) throw new RunCancelledError();
  await page.getByRole('button', { name: 'Request Report' }).first().click();
  for (let i = 0; i < 6; i++) {
    if (run?.cancelled) throw new RunCancelledError();
    await page.waitForTimeout(300);
  }

  if (run?.cancelled) throw new RunCancelledError();
  await pickReportType(page, reportType);

  const dateInputCount = await page.locator("input[placeholder='mm/dd/yyyy']").count();
  if (dateInputCount >= 2 && startStr && endStr) {
    log(send, `[zepto.rep] Filling date range: ${startStr} to ${endStr}`);
    if (run?.cancelled) throw new RunCancelledError();
    await fillDateInput(page, 'from', startStr);
    if (run?.cancelled) throw new RunCancelledError();
    await fillDateInput(page, 'to', endStr);
  } else if (dateInputCount >= 2) {
    throw new Error(`Report type '${reportType}' requires a date range, but none was provided.`);
  }

  if (run?.cancelled) throw new RunCancelledError();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  log(send, '[zepto.rep] Report request submitted. Waiting for processing...');
  for (let i = 0; i < 10; i++) {
    if (run?.cancelled) throw new RunCancelledError();
    await page.waitForTimeout(300);
  }

  return idsBefore;
}

/**
 * Refreshes the reports table until the target request status is 'Completed'.
 */
async function waitForReportCompletion(page, beforeIds, targetRequestId = null, send = () => {}, timeoutSec = 300, run = null) {
  const deadline = Date.now() + timeoutSec * 1000;
  let requestId = targetRequestId;

  while (Date.now() < deadline) {
    if (run?.cancelled) throw new RunCancelledError();

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    if (run?.cancelled) throw new RunCancelledError();
    const rows = await getTableRows(page);

    if (!requestId) {
      const newRows = rows.filter((r) => !beforeIds.has(r.request_id));
      if (newRows.length > 0) {
        requestId = newRows[0].request_id;
        log(send, `[zepto.rep] Registered new report request: ${requestId}`);
      }
    }

    if (requestId) {
      const targetRow = rows.find((r) => r.request_id === requestId);
      if (targetRow) {
        if (targetRow.status.includes('Completed')) {
          log(send, `[zepto.rep] Request ${requestId} is Completed!`);
          return requestId;
        }
        if (targetRow.status.includes('Failed')) {
          throw new Error(`Zepto portal indicated report ${requestId} failed to generate.`);
        }
        log(send, `[zepto.rep] Report ${requestId} is generating (status: ${targetRow.status})...`);
      } else {
        log(send, `[zepto.rep] Waiting for request ${requestId} to appear in table...`);
      }
    } else {
      log(send, '[zepto.rep] Waiting for request to appear in table...');
    }

    // Sleep in small 400ms slices for instant cancellation
    for (let s = 0; s < 15; s++) {
      if (run?.cancelled) throw new RunCancelledError();
      await page.waitForTimeout(400);
    }
  }

  throw new Error(`Report generation timed out after ${timeoutSec}s.`);
}

/**
 * Obtains the report CSV data via presigned S3 URL or button download interception.
 */
async function fetchReportData(page, requestId, send = () => {}, run = null) {
  if (run?.cancelled) throw new RunCancelledError();
  const apiPath = `/api/v1/reports/${requestId}/download`;
  log(send, `[zepto.rep] Resolving download URL for report ${requestId}...`);

  const rowLocator = page.locator('table tbody tr').filter({ hasText: requestId }).first();
  const downloadLink = rowLocator.getByText('Download', { exact: false }).first();

  const [response] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.request().method() === 'GET' &&
        (res.url().includes(`/reports/${requestId}/download`) || res.url().includes(apiPath)),
      { timeout: 60000 }
    ),
    downloadLink.click(),
  ]);

  if (run?.cancelled) throw new RunCancelledError();
  if (!response.ok()) {
    throw new Error(`Zepto download API returned HTTP ${response.status()}`);
  }

  const payload = await response.json();
  const signedUrl = payload?.data?.presignedS3Url;

  if (!signedUrl) {
    throw new Error(`Could not obtain presignedS3Url for report ${requestId}`);
  }

  log(send, '[zepto.rep] Downloading report CSV from presigned S3 storage...');
  if (run?.cancelled) throw new RunCancelledError();
  const s3Res = await fetch(signedUrl);
  if (!s3Res.ok) {
    throw new Error(`Failed to download report from S3: HTTP ${s3Res.status}`);
  }

  const csvText = await s3Res.text();
  const urlObj = new URL(signedUrl);
  const rawFilename = path.basename(decodeURIComponent(urlObj.pathname)) || `report_${requestId}.csv`;
  const filename = rawFilename.replace(/[\\/:*?"<>|]/g, '_');

  return { filename, csvText };
}

/**
 * Finds an existing report or requests a new one and waits for completion.
 */
async function locateOrRequestReport(page, reportType, startStr = null, endStr = null, force = false, send = () => {}, run = null) {
  const span = startStr && endStr ? `${startStr} -> ${endStr}` : 'today';

  if (!force) {
    if (run?.cancelled) throw new RunCancelledError();
    await page.goto(REPORTS_URL, { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 10; i++) {
      if (run?.cancelled) throw new RunCancelledError();
      await page.waitForTimeout(300);
    }

    const existing = await findExistingReport(page, reportType, startStr, endStr);
    if (existing) {
      if (existing.status.includes('Completed')) {
        log(send, `[zepto.rep] Report already generated for ${span} (${existing.request_id}). Reusing it!`);
        return existing.request_id;
      }
      log(send, `[zepto.rep] A request for ${span} is already running (${existing.request_id}). Waiting on it...`);
      return await waitForReportCompletion(page, new Set(), existing.request_id, send, 300, run);
    }
  }

  if (run?.cancelled) throw new RunCancelledError();
  const beforeIds = await requestReport(page, reportType, startStr, endStr, send, run);
  return await waitForReportCompletion(page, beforeIds, null, send, 300, run);
}

/**
 * Default date range (day-2 to day-1).
 */
function getDefaultSalesRange() {
  const now = new Date();
  const day1 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const day2 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2);
  return {
    start: formatPortalDate(day2),
    end: formatPortalDate(day1),
  };
}

/**
 * Action: Sales Sync
 */
async function runSalesSync(page, creds, options, send = () => {}, run = null) {
  log(send, '[zepto.sales] Starting Sales Sync pipeline...');
  const sheetId = creds.sheetId || options.sheetId;
  if (!sheetId) {
    throw new Error('GSHEET_ID / zeptoSheetId is not configured in Settings.');
  }

  const sheets = await getSheetsClient();
  const lookups = await loadLookups(sheets, sheetId, send);

  let startPortal = '';
  let endPortal = '';

  if (options.from && options.to) {
    const sDate = parseAnyDate(options.from);
    const eDate = parseAnyDate(options.to);
    if (!sDate || !eDate) {
      throw new Error(`Invalid custom date format: ${options.from} to ${options.to}`);
    }
    startPortal = formatPortalDate(sDate);
    endPortal = formatPortalDate(eDate);
    log(send, `[zepto.sales] Using requested custom date range: ${startPortal} to ${endPortal}`);
  } else {
    const lookback = options.days ? parseInt(options.days, 10) : 30;
    const { missing } = await getMissingSalesDates(sheets, sheetId, lookback, send);

    if (!missing || missing.length === 0) {
      log(send, `[zepto.sales] Sheet is already up to date — no missing sales dates in the last ${lookback} days.`);
      return { rowsProcessed: 0, datesProcessed: 0, message: 'Sheet is up to date.' };
    }

    const minDate = missing[0];
    const maxDate = missing[missing.length - 1];
    startPortal = formatPortalDate(minDate);
    endPortal = formatPortalDate(maxDate);
    log(send, `[zepto.sales] Missing dates detected: backfilling from ${startPortal} to ${endPortal} (${missing.length} day(s))`);
  }

  if (run?.cancelled) throw new RunCancelledError();
  await ensureSession(page, creds, send, run);
  if (run?.cancelled) throw new RunCancelledError();
  const requestId = await locateOrRequestReport(page, 'Sales_F', startPortal, endPortal, options.force, send, run);
  if (run?.cancelled) throw new RunCancelledError();
  const { filename, csvText } = await fetchReportData(page, requestId, send, run);

  log(send, `[zepto.sales] Transforming Sales CSV (${csvText.length.toLocaleString('en-IN')} bytes)...`);
  const transformedRows = transformSalesCsv(csvText, lookups, send);

  if (options.dryRun) {
    log(send, `[zepto.sales] DRY RUN: Prepared ${transformedRows.length} rows for append. Skipping Google Sheets write.`);
    return { rowsProcessed: transformedRows.length, datesProcessed: 0, dryRun: true };
  }

  if (run?.cancelled) throw new RunCancelledError();
  const result = await appendSalesData(sheets, sheetId, transformedRows, send);
  log(send, `[zepto.sales] Sales Sync completed successfully: +${result.rowsAppended} rows appended across ${result.datesAppended} date(s).`);
  return {
    rowsProcessed: result.rowsAppended,
    datesProcessed: result.datesAppended,
    details: result,
  };
}

/**
 * Action: FC Inventory Refresh
 */
async function runInventoryRefresh(page, creds, options, send = () => {}, run = null) {
  log(send, '[zepto.inv] Starting FC Inventory Refresh pipeline...');
  const sheetId = creds.sheetId || options.sheetId;
  if (!sheetId) {
    throw new Error('GSHEET_ID / zeptoSheetId is not configured in Settings.');
  }

  const sheets = await getSheetsClient();
  if (run?.cancelled) throw new RunCancelledError();
  await ensureSession(page, creds, send, run);
  if (run?.cancelled) throw new RunCancelledError();

  const requestId = await locateOrRequestReport(page, 'Vendor Inventory_F', null, null, options.force, send, run);
  if (run?.cancelled) throw new RunCancelledError();
  const { filename, csvText } = await fetchReportData(page, requestId, send, run);

  if (options.dryRun) {
    log(send, `[zepto.inv] DRY RUN: Downloaded ${filename} (${csvText.length.toLocaleString('en-IN')} bytes). Skipping tab replace.`);
    return { rowsProcessed: 0, dryRun: true };
  }

  if (run?.cancelled) throw new RunCancelledError();
  const targetDate = options.date ? parseAnyDate(options.date) : new Date();
  const result = await refreshInventoryData(sheets, sheetId, csvText, targetDate, send);
  log(send, `[zepto.inv] Inventory refresh complete: ${result.rowsWritten} rows updated (${result.totalUnits} total units).`);
  return {
    rowsProcessed: result.rowsWritten,
    totalUnits: result.totalUnits,
    date: result.date,
  };
}

/**
 * Action: Custom Report Download
 */
async function runDownloadReport(page, creds, options, send = () => {}, run = null) {
  const reportType = options.reportType || 'Sales_F';
  log(send, `[zepto.download] Starting report download for '${reportType}'...`);

  let startPortal = null;
  let endPortal = null;

  if (!isDateless(reportType)) {
    if (options.from && options.to) {
      startPortal = formatPortalDate(parseAnyDate(options.from));
      endPortal = formatPortalDate(parseAnyDate(options.to));
    } else {
      const def = getDefaultSalesRange();
      startPortal = def.start;
      endPortal = def.end;
    }
  }

  if (run?.cancelled) throw new RunCancelledError();
  await ensureSession(page, creds, send, run);
  if (run?.cancelled) throw new RunCancelledError();
  const requestId = await locateOrRequestReport(page, reportType, startPortal, endPortal, options.force, send, run);
  if (run?.cancelled) throw new RunCancelledError();
  const { filename, csvText } = await fetchReportData(page, requestId, send, run);

  const downloadsDir = path.join(__dirname, '..', 'downloads');
  if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
  const targetPath = path.join(downloadsDir, `${reportType}_${stamp}_${filename}`);
  fs.writeFileSync(targetPath, csvText, 'utf8');

  log(send, `[zepto.download] Successfully saved report to: ${targetPath} (${csvText.length.toLocaleString('en-IN')} bytes)`);
  return {
    success: true,
    reportType,
    filePath: targetPath,
    filename,
    bytes: csvText.length,
  };
}

/**
 * Action: Login / Session Check
 */
async function runLoginCheck(page, creds, options, send = () => {}, run = null) {
  const mode = options.mode || 'auto';
  log(send, `[zepto.login] Running session check (mode: ${mode})...`);

  if (run?.cancelled) throw new RunCancelledError();
  await page.goto(REPORTS_URL, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 10; i++) {
    if (run?.cancelled) throw new RunCancelledError();
    await page.waitForTimeout(300);
  }

  if (run?.cancelled) throw new RunCancelledError();
  if (await isLoggedIn(page)) {
    log(send, '[zepto.login] Existing session is valid and authenticated!');
    return { success: true, message: 'Session is active and valid.' };
  }

  if (mode === 'setup') {
    log(send, '[zepto.login] ========================================');
    log(send, '[zepto.login] Interactive Setup Mode:');
    log(send, '[zepto.login] Please enter credentials / OTP via live view.');
    log(send, '[zepto.login] Waiting up to 10 minutes for authentication...');
    log(send, '[zepto.login] ========================================');

    if (run?.cancelled) throw new RunCancelledError();
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    const deadline = Date.now() + 600000;

    while (Date.now() < deadline) {
      if (run?.cancelled) throw new RunCancelledError();
      await page.waitForTimeout(500);
      if (run?.cancelled) throw new RunCancelledError();
      if (await isLoggedIn(page)) {
        log(send, '[zepto.login] Sign-in detected! Session successfully saved.');
        return { success: true, message: 'Setup completed successfully.' };
      }
    }

    throw new Error('Interactive setup timed out before sign-in completed.');
  } else {
    log(send, '[zepto.login] Session not found. Executing auto-login...');
    await autoLogin(page, creds, send, run);
    return { success: true, message: 'Automated login completed successfully.' };
  }
}

/**
 * Main entry point: Executes a Zepto automation job.
 *
 * @param {Function} send - WebSocket message dispatcher
 * @param {Object} options - Job options: { action, headed, days, from, to, dryRun, reportType, force, mode }
 * @returns {Promise<Object>} Job execution summary
 */
async function runZeptoJob(send, options = {}) {
  const creds = getRawZeptoCredentials();
  const action = options.action || options.module || 'daily';

  // Detect if a GUI display is available (Windows, macOS, or Linux with X11 $DISPLAY)
  const hasDisplay = process.platform === 'win32' || process.platform === 'darwin' || Boolean(process.env.DISPLAY);
  let isHeaded = false;
  if (options.headed !== undefined) {
    isHeaded = Boolean(options.headed);
  } else if (creds.headed === '1') {
    isHeaded = true;
  }

  if (isHeaded && !hasDisplay) {
    log(send, '[zepto.browser] Cloud environment has no X11 display. Launching headless browser with real-time Live Canvas view.');
    isHeaded = false;
  }

  log(send, `[zepto] Initializing pure Node.js Zepto Engine (action: ${action}, headless: ${!isHeaded})...`);

  const run = createRunContext('zepto');
  const profileDir = getProfileDir();

  const launchOptions = {
    headless: !isHeaded,
    acceptDownloads: true,
    viewport: { width: 1280, height: 720 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  };

  let context = null;
  let page = null;
  let cdpClient = null;
  const logBuffer = [];

  const wrappedSend = (type, payload = {}) => {
    if (type === 'log' && payload.message) {
      logBuffer.push(payload.message);
    }
    send(type, payload);
  };

  try {
    // Launch persistent browser context
    context = await awaitCancellable(run, chromium.launchPersistentContext(profileDir, launchOptions));
    run.context = context;
    run.browser = context;
    context.setDefaultTimeout(45000);
    context.setDefaultNavigationTimeout(60000);

    if (run.cancelled) throw new RunCancelledError();

    page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    run.page = page;
    setActivePage(page);

    if (run.cancelled) throw new RunCancelledError();

    // Attach real-time CDP screencast to live view canvas
    try {
      cdpClient = await setupScreencast(run, context, page, wrappedSend);
      log(wrappedSend, '[zepto.view] Live CDP screencast stream active.');
    } catch (screencastErr) {
      if (run.cancelled) throw new RunCancelledError();
      log(wrappedSend, `[zepto.view] Screencast notice: ${screencastErr.message}`);
    }

    if (run.cancelled) throw new RunCancelledError();

    let result = null;

    switch (action) {
      case 'sales':
      case 'sheet_pipeline':
        result = await awaitCancellable(run, runSalesSync(page, creds, options, wrappedSend, run));
        break;

      case 'inventory':
      case 'inventory_pipeline':
        result = await awaitCancellable(run, runInventoryRefresh(page, creds, options, wrappedSend, run));
        break;

      case 'login':
      case 'auth':
        result = await awaitCancellable(run, runLoginCheck(page, creds, options, wrappedSend, run));
        break;

      case 'download':
      case 'download_report':
        result = await awaitCancellable(run, runDownloadReport(page, creds, options, wrappedSend, run));
        break;

      case 'daily':
      case 'run_daily':
      default:
        log(wrappedSend, '[zepto.daily] ----------------------------------------');
        log(wrappedSend, '[zepto.daily] STAGE 1: Sales Sync (Missed Dates Backfill)');
        log(wrappedSend, '[zepto.daily] ----------------------------------------');
        const salesRes = await awaitCancellable(run, runSalesSync(page, creds, options, wrappedSend, run));

        if (run.cancelled) throw new RunCancelledError();

        log(wrappedSend, '[zepto.daily] ----------------------------------------');
        log(wrappedSend, '[zepto.daily] STAGE 2: FC Inventory Snapshot Refresh');
        log(wrappedSend, '[zepto.daily] ----------------------------------------');
        const invRes = await awaitCancellable(run, runInventoryRefresh(page, creds, options, wrappedSend, run));

        result = {
          success: true,
          action: 'daily',
          rowsProcessed: (salesRes.rowsProcessed || 0) + (invRes.rowsProcessed || 0),
          salesRows: salesRes.rowsProcessed || 0,
          inventoryRows: invRes.rowsProcessed || 0,
          totalUnits: invRes.totalUnits || 0,
          message: 'Zepto Daily Full Sync finished successfully.',
        };
        break;
    }

    log(wrappedSend, `[zepto] Automation completed successfully: ${result.message || action}`);
    return {
      success: true,
      portal: 'Zepto',
      action,
      ...result,
    };
  } catch (err) {
    const isCancelled =
      run.cancelled ||
      err.code === 'RUN_CANCELLED' ||
      err instanceof RunCancelledError ||
      (err.message && (
        err.message.includes('Target page, context or browser has been closed') ||
        err.message.includes('TargetClosedError') ||
        err.message.includes('Browser has been closed') ||
        err.message.includes('closed') ||
        err.message.includes('cancelled')
      ) && run.cancelled);

    if (isCancelled) {
      log(wrappedSend, '[zepto] Process stopped immediately upon user request.');
      throw new RunCancelledError();
    }

    const errorMsg = `Zepto ${action} failed: ${err.message}`;
    warn(wrappedSend, `[zepto] ${errorMsg}`);

    // Send failure alerts
    const tailLogs = logBuffer.slice(-30).join('\n');
    await sendZeptoAlert(action, err.message, tailLogs).catch(() => {});
    await sendAlert(`Zepto ${action} Failed`, errorMsg, { error: err.message }).catch(() => {});

    throw err;
  } finally {
    if (cdpClient) {
      await stopScreencast(cdpClient).catch(() => {});
    }
    clearActivePage(page);
    if (context) {
      await context.close().catch(() => {});
    }
    run.resolveCancel();
    clearActiveRun(run);
  }
}

module.exports = {
  runZeptoJob,
  runSalesSync,
  runInventoryRefresh,
  runDownloadReport,
  runLoginCheck,
  formatPortalDate,
};
