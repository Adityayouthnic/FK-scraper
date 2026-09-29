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
const { chromium } = require('playwright-extra');
const stealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(stealthPlugin());
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
const { getSheetsClient, getAuthIdentity } = require('./googleAuth');
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
  if (process.env.ZEPTO_PROFILE_DIR && fs.existsSync(process.env.ZEPTO_PROFILE_DIR)) {
    return process.env.ZEPTO_PROFILE_DIR;
  }
  const localDir = path.join(__dirname, '..', 'secrets', 'zepto_profile');
  if (!fs.existsSync(localDir)) {
    try {
      fs.mkdirSync(localDir, { recursive: true });
    } catch {}
  }
  return localDir;
}

/**
 * In-memory cache of storageState (cookies & localStorage) across runs within node process.
 */
let inMemoryZeptoSession = null;

/**
 * Returns candidate paths where Zepto storage state (cookies & localStorage) may be found or saved.
 */
function getSessionStatePaths() {
  const profileDir = getProfileDir();
  return [
    process.env.ZEPTO_STORAGE_STATE_PATH,
    path.join(__dirname, '..', 'secrets', 'storage_state.json'),
    path.join(profileDir, 'storage_state.json'),
    path.join('C:', 'Tools 2.0', 'Zepto_Auto_sale', 'secrets', 'storage_state.json'),
  ].filter(Boolean);
}

/**
 * Loads saved Zepto session state from memory or disk if available.
 */
function loadSavedSessionState(send = () => {}) {
  // 1. Check in-memory session cache first
  if (inMemoryZeptoSession && (inMemoryZeptoSession.cookies?.length || inMemoryZeptoSession.origins?.length)) {
    log(send, `[zepto.auth] Reusing active session state from memory (${inMemoryZeptoSession.cookies?.length || 0} cookies, ${inMemoryZeptoSession.origins?.length || 0} origin entries).`);
    return inMemoryZeptoSession;
  }

  // 2. Check ZEPTO_STORAGE_STATE environment variable if configured
  if (process.env.ZEPTO_STORAGE_STATE) {
    try {
      const parsed = JSON.parse(process.env.ZEPTO_STORAGE_STATE);
      if (parsed && (parsed.cookies?.length || parsed.origins?.length)) {
        inMemoryZeptoSession = parsed;
        log(send, `[zepto.auth] Loaded session state from ZEPTO_STORAGE_STATE env (${parsed.cookies?.length || 0} cookies, ${parsed.origins?.length || 0} origin entries).`);
        return inMemoryZeptoSession;
      }
    } catch {}
  }

  // 3. Check candidate files on disk
  const paths = getSessionStatePaths();
  for (const p of paths) {
    if (fs.existsSync(p)) {
      try {
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && (parsed.cookies?.length || parsed.origins?.length)) {
          inMemoryZeptoSession = parsed;
          log(send, `[zepto.auth] Loaded saved session state from ${path.basename(p)} (${parsed.cookies?.length || 0} cookies, ${parsed.origins?.length || 0} origin entries).`);
          return inMemoryZeptoSession;
        }
      } catch (err) {
        log(send, `[zepto.auth] Note reading session state: ${err.message}`);
      }
    }
  }

  return null;
}

/**
 * Saves current authenticated cookies and localStorage to memory and disk.
 */
async function saveZeptoSession(context, page = null, send = () => {}) {
  try {
    if (!context) return;
    const state = await context.storageState().catch(() => null);
    if (!state || (!state.cookies?.length && !state.origins?.length)) return;

    inMemoryZeptoSession = state;

    const targets = [
      path.join(__dirname, '..', 'secrets', 'storage_state.json'),
      path.join(getProfileDir(), 'storage_state.json'),
    ];

    for (const t of targets) {
      try {
        fs.mkdirSync(path.dirname(t), { recursive: true });
        fs.writeFileSync(t, JSON.stringify(state, null, 2), 'utf8');
      } catch {}
    }

    log(send, `[zepto.auth] Session state preserved for subsequent runs (${state.cookies?.length || 0} cookies, ${state.origins?.length || 0} origin entries).`);
  } catch (err) {
    // Non-fatal
  }
}

/**
 * Returns current session health metadata.
 */
function getZeptoSessionStatus() {
  const savedState = loadSavedSessionState();
  if (savedState) {
    return {
      authenticated: true,
      cookiesCount: savedState.cookies?.length || 0,
      originsCount: savedState.origins?.length || 0,
      source: inMemoryZeptoSession ? 'memory' : 'file',
    };
  }
  return {
    authenticated: false,
    cookiesCount: 0,
    originsCount: 0,
  };
}

/**
 * Removes stale Chrome profile lock files (SingletonLock, SingletonCookie, SingletonSocket)
 * to prevent startup crashes when previous runs exited abruptly.
 */
function cleanupStaleProfileLocks(profileDir) {
  if (!fs.existsSync(profileDir)) return;
  const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
  for (const f of lockFiles) {
    const p = path.join(profileDir, f);
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch (_) {}
    }
  }
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
 * Parses portal date string in MM/DD/YYYY format.
 */
function parsePortalDate(str) {
  if (!str) return null;
  const s = String(str).trim();
  const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) {
    return new Date(parseInt(m[3], 10), parseInt(m[1], 10) - 1, parseInt(m[2], 10));
  }
  return parseAnyDate(str);
}

/**
 * Compares table date range with requested from/to date strings.
 */
function rangeMatches(rangeCell, startStr, endStr) {
  const found = parseTableDates(rangeCell);
  if (found.length !== 2) return false;

  const sDate = parsePortalDate(startStr);
  const eDate = parsePortalDate(endStr);
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
 * Types text into a locator character-by-character with realistic human-like cadence.
 */
async function humanType(locator, text, page) {
  await locator.click();
  await page.waitForTimeout(100 + Math.random() * 100);
  await locator.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await locator.press('Backspace');
  await page.waitForTimeout(60 + Math.random() * 60);
  for (const ch of String(text || '')) {
    await locator.pressSequentially(ch, { delay: 40 + Math.random() * 60 });
  }
  await page.waitForTimeout(120 + Math.random() * 150);
}

/**
 * Checks whether the current page is authenticated and in the vendor workspace.
 */
async function isLoggedIn(page) {
  try {
    const currentUrl = page.url();
    const parsed = new URL(currentUrl);
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';

    if (AUTH_PATHS.includes(pathname) || PUBLIC_PATHS.includes(pathname) || pathname === '/') {
      return false;
    }

    if (!pathname.startsWith('/vendor')) {
      return false;
    }

    const emailField = page.locator('input[placeholder="Email ID"]');
    if (await emailField.isVisible({ timeout: 400 }).catch(() => false)) {
      return false;
    }

    const otpInput = await findOtpInput(page);
    if (otpInput && await otpInput.first().isVisible({ timeout: 400 }).catch(() => false)) {
      return false;
    }

    const bodyText = (await page.innerText('body').catch(() => '')).toLowerCase();
    if (bodyText.includes('verify you are human') || bodyText.includes('access denied')) {
      return false;
    }

    return true;
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
      const box = field.nth(i);
      await box.click();
      await page.waitForTimeout(50 + Math.random() * 50);
      await box.pressSequentially(code[i], { delay: 60 + Math.random() * 60 });
      await page.waitForTimeout(50 + Math.random() * 50);
    }
  } else {
    await field.first().click();
    await page.waitForTimeout(100);
    await field.first().pressSequentially(code, { delay: 70 + Math.random() * 60 });
  }

  await page.waitForTimeout(600 + Math.random() * 400);

  const buttonNames = ['Confirm', 'Verify', 'Submit', 'Continue', 'Log In'];
  for (const name of buttonNames) {
    try {
      const btn = page.getByRole('button', { name, exact: false });
      const btnCount = await btn.count();
      if (btnCount > 0 && await btn.first().isEnabled()) {
        log(send, `[zepto.auth] Submitting OTP via '${name}' button...`);
        await btn.first().hover().catch(() => {});
        await page.waitForTimeout(200);
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

  log(send, '[zepto.auth] Navigating to login portal with stealth profile...');
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

  log(send, '[zepto.auth] Entering credentials with human cadence...');
  await humanType(emailInput, email, page);
  await humanType(passwordInput, password, page);

  const submittedAt = Date.now();
  await page.waitForTimeout(300 + Math.random() * 200);

  const loginBtn = page.getByRole('button', { name: 'Log In' });
  await loginBtn.hover().catch(() => {});
  await page.waitForTimeout(150);
  await loginBtn.click();

  // Poll for dashboard, OTP challenge, or credentials error
  let otpFound = false;
  for (let i = 0; i < 25; i++) {
    if (run?.cancelled) throw new RunCancelledError();
    await page.waitForTimeout(1500);

    if (await isLoggedIn(page)) {
      log(send, '[zepto.auth] Signed in — no OTP was required.');
      await saveZeptoSession(page.context(), page, send);
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
    if (bodyText.includes('verify you are human') || bodyText.includes('cloudflare')) {
      log(send, '[zepto.auth] Bot challenge displayed on login. Operator can interact via Live Canvas.');
    }
  }

  if (run?.cancelled) throw new RunCancelledError();
  if (!otpFound) {
    const currentUrl = page.url();
    const bodySample = (await page.innerText('body').catch(() => '')).slice(0, 200).replace(/\n+/g, ' ');
    throw new Error(`Neither dashboard nor OTP screen appeared (URL: ${currentUrl}, screen: "${bodySample}").`);
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

  for (let i = 0; i < 25; i++) {
    if (run?.cancelled) throw new RunCancelledError();
    await page.waitForTimeout(1500);

    if (await isLoggedIn(page)) {
      log(send, '[zepto.auth] OTP accepted — successfully authenticated to Zepto!');
      await saveZeptoSession(page.context(), page, send);
      return;
    }

    const bodyText = (await page.innerText('body').catch(() => '')).toLowerCase();
    if (bodyText.includes('invalid otp') || bodyText.includes('incorrect otp')) {
      throw new Error('Zepto portal rejected OTP: "Invalid OTP entered".');
    }
    if (bodyText.includes('too many attempts') || bodyText.includes('rate limit')) {
      throw new Error('Zepto portal throttled login: "Too many attempts". Please wait a few minutes.');
    }
  }

  const currentUrl = page.url();
  const bodySample = (await page.innerText('body').catch(() => '')).slice(0, 250).replace(/\n+/g, ' ');
  throw new Error(`OTP submitted but sign-in was not confirmed (URL: ${currentUrl}, screen: "${bodySample}").`);
}

/**
 * Opens or focuses the reports page and waits for it to be interactive.
 */
async function openReports(page, send = () => {}, run = null) {
  if (run?.cancelled) throw new RunCancelledError();
  const currentUrl = page.url();

  if (currentUrl.includes('/vendor/reports')) {
    log(send, '[zepto.rep] Already on Reports view.');
  } else {
    log(send, `[zepto.rep] Opening Reports portal (${REPORTS_URL})...`);
    await page.goto(REPORTS_URL, { waitUntil: 'domcontentloaded' });
  }

  // Wait for the reports page components to stabilize
  for (let i = 0; i < 20; i++) {
    if (run?.cancelled) throw new RunCancelledError();

    if (page.url().includes('/login')) {
      log(send, '[zepto.rep] Session expired or unauthenticated — redirected to login.');
      return false;
    }

    const bodyText = (await page.innerText('body').catch(() => '')).toLowerCase();
    if (bodyText.includes('verify you are human') || bodyText.includes('access denied') || bodyText.includes('cloudflare')) {
      log(send, '[zepto.rep] WARNING: Bot challenge or access verification detected on screen.');
      return false;
    }

    const reqBtn = page.getByRole('button', { name: 'Request Report' });
    if (await reqBtn.count().then(c => c > 0).catch(() => false) && await reqBtn.first().isVisible().catch(() => false)) {
      await waitForTableReady(page, 5000);
      return true;
    }

    const tableRows = await getTableRows(page);
    if (tableRows.length > 0) {
      return true;
    }

    await page.waitForTimeout(400);
  }

  return true;
}

/**
 * Ensures browser has an active authenticated session.
 * Reuses existing session cookies & storage state whenever valid.
 * Does not navigate or trigger login unless strictly necessary.
 */
async function ensureSession(page, creds, send = () => {}, run = null) {
  log(send, '[zepto.auth] Checking portal session status...');
  if (run?.cancelled) throw new RunCancelledError();

  // 1. If page is already on /vendor and authenticated, reuse immediately without reloading!
  if (await isLoggedIn(page)) {
    log(send, '[zepto.auth] Active session verified and ready (reusing existing session).');
    await saveZeptoSession(page.context(), page, send);
    return;
  }

  // 2. Open Reports portal to verify session
  const isReady = await openReports(page, send, run);
  if (run?.cancelled) throw new RunCancelledError();

  if (isReady && await isLoggedIn(page)) {
    log(send, '[zepto.auth] Active session verified and ready.');
    await saveZeptoSession(page.context(), page, send);
    return;
  }

  // 3. Before triggering credentials login, check if LOGIN_URL bounces automatically to dashboard
  log(send, '[zepto.auth] Verifying portal session cookie...');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2000);

  if (run?.cancelled) throw new RunCancelledError();
  if (await isLoggedIn(page)) {
    log(send, '[zepto.auth] Portal recognized existing session. Reusing authenticated session.');
    await saveZeptoSession(page.context(), page, send);
    await openReports(page, send, run);
    return;
  }

  // 4. Only if all checks confirm no active session exists, initiate automated sign-in
  log(send, '[zepto.auth] Session not active. Initiating automated sign-in...');
  await autoLogin(page, creds, send, run);

  if (run?.cancelled) throw new RunCancelledError();
  await saveZeptoSession(page.context(), page, send);
  await openReports(page, send, run);
}

/**
 * Waits for the reports table to have at least one row rendered.
 */
async function waitForTableReady(page, timeoutMs = 12000) {
  try {
    await page.locator('table tbody tr, table tr').first().waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {}
}

/**
 * Reads all rows from the Reports table.
 */
async function getTableRows(page) {
  try {
    return await page.evaluate(() => {
      // Find header column mappings if available
      const ths = Array.from(document.querySelectorAll('table thead th'));
      const headerNames = ths.map((th) => (th.innerText || th.textContent || '').trim().toLowerCase());

      const reqAtIdx = headerNames.findIndex((h) => h.includes('requested'));
      const reqIdIdx = headerNames.findIndex((h) => h.includes('request id') || h.includes('id'));
      const typeIdx = headerNames.findIndex((h) => h.includes('type'));
      const rangeIdx = headerNames.findIndex((h) => h.includes('range') || h.includes('date'));
      const statusIdx = headerNames.findIndex((h) => h.includes('status'));
      const actionIdx = headerNames.findIndex((h) => h.includes('action'));

      const trs = Array.from(document.querySelectorAll('table tbody tr'));
      return trs
        .map((r, idx) => {
          const cells = Array.from(r.querySelectorAll('td, th'));
          if (cells.length < 3) return null;

          const cellTexts = cells.map((c) => (c.innerText || c.textContent || '').trim());

          // Primary: Read via header indices if found
          let requested_at = reqAtIdx >= 0 && reqAtIdx < cellTexts.length ? cellTexts[reqAtIdx] : '';
          let request_id = '';
          let type = typeIdx >= 0 && typeIdx < cellTexts.length ? cellTexts[typeIdx] : '';
          let range = rangeIdx >= 0 && rangeIdx < cellTexts.length ? cellTexts[rangeIdx] : '';
          let status = statusIdx >= 0 && statusIdx < cellTexts.length ? cellTexts[statusIdx] : '';
          let actionText = actionIdx >= 0 && actionIdx < cellTexts.length ? cellTexts[actionIdx] : '';

          // Request ID: check title attribute or text
          if (reqIdIdx >= 0 && reqIdIdx < cells.length) {
            const idCell = cells[reqIdIdx];
            const title = idCell.getAttribute('title') || idCell.querySelector('[title]')?.getAttribute('title');
            if (title && /[0-9a-fA-F-]{16,}/.test(title)) {
              request_id = title.trim();
            } else {
              request_id = cellTexts[reqIdIdx];
            }
          }

          // Content-based heuristic fallback if headers didn't resolve all fields
          for (let i = 0; i < cells.length; i++) {
            const txt = cellTexts[i];
            const cell = cells[i];

            if (!status && (txt.includes('Completed') || txt.includes('Generating') || txt.includes('Failed') || txt.includes('In Progress'))) {
              status = txt;
            }
            if (!type && (/^sales$/i.test(txt) || /^inventory$/i.test(txt) || /sales/i.test(txt))) {
              type = txt;
            }
            if (!range && (/\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}/.test(txt) && txt.includes('-'))) {
              range = txt;
            } else if (!range && txt === '-') {
              range = '-';
            }
            if (!actionText && /download/i.test(txt)) {
              actionText = txt;
            }
            if (!request_id) {
              const title = cell.getAttribute('title') || cell.querySelector('[title]')?.getAttribute('title');
              if (title && /[0-9a-fA-F-]{16,}/.test(title)) {
                request_id = title.trim();
              } else if (/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}/.test(txt) || /[0-9a-fA-F-]{16,}/.test(txt)) {
                request_id = txt;
              }
            }
            if (!requested_at && (/\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}/.test(txt) && !txt.includes('-'))) {
              requested_at = txt;
            }
          }

          const hasDownloadBtn = Boolean(r.querySelector('button, a, [role="button"]') && /download/i.test(r.innerText));

          return {
            row_index: idx,
            requested_at,
            request_id,
            type,
            range,
            status,
            has_download: /download/i.test(actionText) || hasDownloadBtn,
          };
        })
        .filter(Boolean);
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
    if (row.status.toLowerCase().includes('failed')) continue;

    if (startStr && endStr) {
      if (!rangeMatches(row.range, startStr, endStr)) continue;
    } else {
      if (/\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}/.test(row.range)) continue;
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

  await openReports(page, send, run);
  await waitForTableReady(page, 6000);

  const rowsBefore = await getTableRows(page);
  const idsBefore = new Set(rowsBefore.map((r) => r.request_id).filter(Boolean));

  if (run?.cancelled) throw new RunCancelledError();

  // Multi-selector strategy for 'Request Report' button
  const reqBtnSelectors = [
    () => page.getByRole('button', { name: 'Request Report' }),
    () => page.locator("button:has-text('Request Report')"),
    () => page.locator("[role='button']:has-text('Request Report')"),
    () => page.getByText('Request Report', { exact: true }),
  ];

  let reqBtn = null;
  for (let i = 0; i < 20; i++) {
    if (run?.cancelled) throw new RunCancelledError();
    for (const build of reqBtnSelectors) {
      try {
        const loc = build();
        if (await loc.count() > 0 && await loc.first().isVisible()) {
          reqBtn = loc.first();
          break;
        }
      } catch {}
    }
    if (reqBtn) break;
    await page.waitForTimeout(500);
  }

  if (!reqBtn) {
    const currentUrl = page.url();
    const bodySample = (await page.innerText('body').catch(() => '')).slice(0, 300).replace(/\n+/g, ' ');
    throw new Error(`Could not find 'Request Report' button on portal. (URL: ${currentUrl}, Page preview: "${bodySample}")`);
  }

  log(send, '[zepto.rep] Opening report request modal...');
  await reqBtn.hover().catch(() => {});
  await page.waitForTimeout(200);
  await reqBtn.click();
  await page.waitForTimeout(2000);

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
  const submitBtn = page.getByRole('button', { name: 'Submit', exact: true });
  await submitBtn.hover().catch(() => {});
  await page.waitForTimeout(200);
  await submitBtn.click();
  log(send, '[zepto.rep] Report request submitted. Waiting for processing...');

  // Wait for modal dialog to dismiss
  try {
    await page.locator('[role="dialog"]').waitFor({ state: 'hidden', timeout: 8000 });
  } catch {}

  for (let i = 0; i < 5; i++) {
    if (run?.cancelled) throw new RunCancelledError();
    await page.waitForTimeout(400);
  }

  return idsBefore;
}

/**
 * Refreshes the reports table until the target request status is 'Completed'.
 */
async function waitForReportCompletion(
  page,
  beforeIds = new Set(),
  targetRequestId = null,
  send = () => {},
  timeoutSec = 300,
  run = null,
  reportType = null,
  startStr = null,
  endStr = null
) {
  const deadline = Date.now() + timeoutSec * 1000;
  let requestId = targetRequestId;
  let iteration = 0;

  while (Date.now() < deadline) {
    if (run?.cancelled) throw new RunCancelledError();
    iteration++;

    // On iteration 1: modal was just submitted, check the rendered DOM first without reloading!
    // On iteration > 1: reload the page to refresh status from backend
    if (iteration > 1) {
      log(send, `[zepto.rep] Refreshing reports table (check #${iteration})...`);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForTableReady(page, 15000);
      await page.waitForTimeout(2000);
    } else {
      await waitForTableReady(page, 8000);
      await page.waitForTimeout(1500);
    }

    if (run?.cancelled) throw new RunCancelledError();
    const rows = await getTableRows(page);
    log(send, `[zepto.rep] Table inspect: found ${rows.length} row(s) in view.`);

    let matchedRow = null;

    // Strategy A: If target requestId is already known, match by exact ID or prefix
    if (requestId && requestId !== 'top_row') {
      const cleanReqId = requestId.replace(/\.+$/, '');
      matchedRow = rows.find(
        (r) =>
          r.request_id &&
          (r.request_id === requestId ||
            r.request_id.startsWith(cleanReqId) ||
            cleanReqId.startsWith(r.request_id.replace(/\.+$/, '')))
      );
    }

    // Strategy B: Diff against beforeIds (brand new request ID)
    if (!matchedRow && beforeIds && beforeIds.size > 0) {
      const newRows = rows.filter((r) => r.request_id && !beforeIds.has(r.request_id));
      if (newRows.length > 0) {
        matchedRow = newRows[0];
        requestId = matchedRow.request_id;
        log(send, `[zepto.rep] Registered new report request ID via table diff: ${requestId}`);
      }
    }

    // Strategy C: Topmost row match (Zepto puts newly requested reports at row 0)
    if (!matchedRow && rows.length > 0 && reportType) {
      const topRow = rows[0];
      const typeOk = typeMatches(topRow.type, reportType);
      let rangeOk = false;
      if (startStr && endStr) {
        rangeOk = rangeMatches(topRow.range, startStr, endStr);
      } else {
        rangeOk = !/\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}/.test(topRow.range) || isRequestedToday(topRow.requested_at);
      }

      if (typeOk && rangeOk) {
        matchedRow = topRow;
        if (!requestId && topRow.request_id) {
          requestId = topRow.request_id;
        }
        log(send, `[zepto.rep] Topmost table row matches requested report '${reportType}': ${requestId || '(row 0)'}`);
      }
    }

    // Strategy D: Search any row matching reportType and date range that is Completed or Generating
    if (!matchedRow && rows.length > 0 && reportType) {
      for (const r of rows) {
        if (!typeMatches(r.type, reportType)) continue;
        if (r.status.includes('Failed')) continue;

        let rangeOk = false;
        if (startStr && endStr) {
          rangeOk = rangeMatches(r.range, startStr, endStr);
        } else {
          rangeOk = !/\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}/.test(r.range) && isRequestedToday(r.requested_at);
        }

        if (rangeOk) {
          matchedRow = r;
          if (!requestId && r.request_id) {
            requestId = r.request_id;
          }
          log(send, `[zepto.rep] Found matching report row in table: ${requestId || r.type}`);
          break;
        }
      }
    }

    // Evaluate matched row status
    if (matchedRow) {
      const statusText = matchedRow.status || '';
      log(send, `[zepto.rep] Report status: "${statusText}" (ID: ${matchedRow.request_id || requestId || 'top row'})`);

      if (statusText.toLowerCase().includes('completed')) {
        log(send, `[zepto.rep] Request ${matchedRow.request_id || requestId || 'top row'} is Completed!`);
        return matchedRow.request_id || requestId || 'top_row';
      }

      if (statusText.toLowerCase().includes('failed')) {
        throw new Error(`Zepto portal indicated report generation failed for ${reportType || 'report'}.`);
      }

      log(send, `[zepto.rep] Report is currently generating (${statusText}). Waiting before next refresh...`);
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
async function fetchReportData(page, requestId, send = () => {}, run = null, reportType = null, startStr = null, endStr = null) {
  if (run?.cancelled) throw new RunCancelledError();
  log(send, `[zepto.rep] Locating download for ${reportType || 'report'} (${requestId || 'existing row'})...`);

  await waitForTableReady(page, 6000);

  // 1. Locate the target row
  let rowLocator = null;
  const cleanId = (requestId || '').replace(/\.+$/, '').replace(/^row_\d+$/, '').trim();

  // Try matching by requestId prefix if available
  if (cleanId && cleanId !== 'top_row') {
    const shortId = cleanId.slice(0, 16);
    const candidate = page.locator('table tbody tr').filter({ hasText: shortId }).first();
    if (await candidate.count().then((c) => c > 0).catch(() => false)) {
      rowLocator = candidate;
    }
  }

  // Try matching by reportType and date range snippet if applicable
  if (!rowLocator && startStr) {
    const sDate = parsePortalDate(startStr);
    if (sDate) {
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const dayStr = String(sDate.getDate()).padStart(2, '0');
      const dateSnippet = `${dayStr} ${monthNames[sDate.getMonth()]} ${sDate.getFullYear()}`;
      const typeBadge = reportType && reportType.toLowerCase().includes('sale') ? 'SALES' : 'INVENTORY';

      const candidate = page
        .locator('table tbody tr')
        .filter({ hasText: typeBadge })
        .filter({ hasText: dateSnippet })
        .filter({ hasText: 'Download' })
        .first();

      if (await candidate.count().then((c) => c > 0).catch(() => false)) {
        log(send, `[zepto.rep] Located target row via date range snippet: ${dateSnippet}`);
        rowLocator = candidate;
      }
    }
  }

  // Try matching by row index if requestId is row_N
  if (!rowLocator && requestId && String(requestId).startsWith('row_')) {
    const rowIdx = parseInt(String(requestId).replace('row_', ''), 10);
    const candidate = page.locator('table tbody tr').nth(rowIdx);
    if (await candidate.count().then((c) => c > 0).catch(() => false)) {
      rowLocator = candidate;
    }
  }

  // Fallback: match by reportType badge + Download
  if (!rowLocator && reportType) {
    const typeBadge = reportType.toLowerCase().includes('sale') ? 'SALES' : 'INVENTORY';
    const candidate = page
      .locator('table tbody tr')
      .filter({ hasText: typeBadge })
      .filter({ hasText: 'Download' })
      .first();
    if (await candidate.count().then((c) => c > 0).catch(() => false)) {
      rowLocator = candidate;
    }
  }

  // Last resort: topmost row with Download
  if (!rowLocator) {
    rowLocator = page.locator('table tbody tr').filter({ hasText: 'Download' }).first();
  }

  if (await rowLocator.count() === 0) {
    throw new Error(`Could not locate report row with 'Download' button for ${reportType || 'report'}.`);
  }

  const downloadBtn = rowLocator.getByText('Download', { exact: false }).first();
  await downloadBtn.scrollIntoViewIfNeeded().catch(() => {});

  // Set up listeners BEFORE clicking:
  const responsePromise = page
    .waitForResponse(
      (res) => {
        const url = res.url();
        const isGet = res.request().method() === 'GET';
        return isGet && (
          (url.includes('/reports/') && url.includes('/download')) ||
          url.includes('presignedS3Url') ||
          url.includes('s3.amazonaws.com')
        );
      },
      { timeout: 45000 }
    )
    .catch(() => null);

  const downloadEventPromise = page.waitForEvent('download', { timeout: 45000 }).catch(() => null);

  log(send, '[zepto.rep] Clicking Download button in portal...');
  await downloadBtn.hover().catch(() => {});
  await page.waitForTimeout(200);
  await downloadBtn.click();

  const [apiResponse, downloadEvent] = await Promise.all([
    responsePromise,
    downloadEventPromise,
  ]);

  if (run?.cancelled) throw new RunCancelledError();

  let csvText = '';
  let filename = '';

  // Strategy 1: Read presignedS3Url from API response
  if (apiResponse && apiResponse.ok()) {
    try {
      const payload = await apiResponse.json();
      const signedUrl = payload?.data?.presignedS3Url;
      if (signedUrl) {
        log(send, '[zepto.rep] Captured presigned S3 URL from download API. Fetching CSV...');
        const s3Res = await fetch(signedUrl);
        if (s3Res.ok) {
          csvText = await s3Res.text();
          const urlObj = new URL(signedUrl);
          const rawFilename = path.basename(decodeURIComponent(urlObj.pathname)) || `report_${Date.now()}.csv`;
          filename = rawFilename.replace(/[\\/:*?"<>|]/g, '_');
        }
      }
    } catch (e) {
      log(send, `[zepto.rep] Presigned URL parse note: ${e.message}`);
    }
  }

  // Strategy 2: Use browser download stream if available
  if (!csvText && downloadEvent) {
    log(send, '[zepto.rep] Using browser download stream...');
    try {
      const stream = await downloadEvent.createReadStream();
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      csvText = Buffer.concat(chunks).toString('utf8');
      filename = downloadEvent.suggestedFilename() || `report_${Date.now()}.csv`;
    } catch (e) {
      log(send, `[zepto.rep] Download stream read note: ${e.message}`);
    }
  }

  // Strategy 3: Check downloads directory if Playwright saved the file
  if (!csvText && downloadEvent) {
    try {
      const filePath = await downloadEvent.path();
      if (filePath && fs.existsSync(filePath)) {
        csvText = fs.readFileSync(filePath, 'utf8');
        filename = downloadEvent.suggestedFilename() || path.basename(filePath);
      }
    } catch {}
  }

  if (!csvText || csvText.trim().length === 0) {
    throw new Error('Failed to capture report CSV from either S3 presigned URL or browser download event.');
  }

  log(send, `[zepto.rep] Successfully acquired report (${filename}, ${csvText.length.toLocaleString('en-IN')} bytes).`);
  return { filename, csvText };
}

/**
 * Finds an existing report or requests a new one and waits for completion.
 */
async function locateOrRequestReport(page, reportType, startStr = null, endStr = null, force = false, send = () => {}, run = null) {
  const span = startStr && endStr ? `${startStr} -> ${endStr}` : 'today';

  if (!force) {
    if (run?.cancelled) throw new RunCancelledError();
    await openReports(page, send, run);
    await waitForTableReady(page, 6000);

    const existing = await findExistingReport(page, reportType, startStr, endStr);
    if (existing) {
      if (existing.status.toLowerCase().includes('completed')) {
        log(send, `[zepto.rep] Existing completed report found for ${span} (ID: ${existing.request_id || 'row ' + existing.row_index}). Directly downloading without regenerating!`);
        return existing.request_id || `row_${existing.row_index}`;
      }
      log(send, `[zepto.rep] A request for ${span} is already in table (${existing.request_id || 'row ' + existing.row_index}, status: ${existing.status}). Waiting on it...`);
      return await waitForReportCompletion(page, new Set(), existing.request_id, send, 300, run, reportType, startStr, endStr);
    }
    log(send, `[zepto.rep] No existing report found for ${span}. Submitting a new request via portal...`);
  }

  if (run?.cancelled) throw new RunCancelledError();
  const beforeIds = await requestReport(page, reportType, startStr, endStr, send, run);
  return await waitForReportCompletion(page, beforeIds, null, send, 300, run, reportType, startStr, endStr);
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
  const authIdent = getAuthIdentity();
  log(send, `[zepto.sheet] Connected via ${authIdent.type === 'oauth' ? 'OAuth User' : 'Service Account'} (${authIdent.identity}).`);
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
  const { filename, csvText } = await fetchReportData(page, requestId, send, run, 'Sales_F', startPortal, endPortal);

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
  const { filename, csvText } = await fetchReportData(page, requestId, send, run, 'Vendor Inventory_F', null, null);

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
  const { filename, csvText } = await fetchReportData(page, requestId, send, run, reportType, startPortal, endPortal);

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
    await saveZeptoSession(page.context(), page, send);
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
        await saveZeptoSession(page.context(), page, send);
        return { success: true, message: 'Setup completed successfully.' };
      }
    }

    throw new Error('Interactive setup timed out before sign-in completed.');
  } else {
    log(send, '[zepto.login] Session not found. Executing auto-login...');
    await autoLogin(page, creds, send, run);
    await saveZeptoSession(page.context(), page, send);
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
  const savedState = loadSavedSessionState(wrappedSend);

  const launchOptions = {
    headless: !isHeaded,
    acceptDownloads: true,
    viewport: { width: 1600, height: 900 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-infobars',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1600,900',
      '--start-maximized',
    ],
    ...(savedState ? { storageState: savedState } : {}),
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
    // Gracefully clean up stale SingletonLocks from aborted runs
    cleanupStaleProfileLocks(profileDir);

    // Launch persistent browser context
    context = await awaitCancellable(run, chromium.launchPersistentContext(profileDir, launchOptions));
    run.context = context;
    run.browser = context;
    context.setDefaultTimeout(45000);
    context.setDefaultNavigationTimeout(60000);

    // Inject advanced in-page stealth evasions to prevent bot detection
    await context.addInitScript(() => {
      // 1. Hide navigator.webdriver
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
        configurable: true,
      });

      // 2. Mock Chrome runtime object
      if (!window.chrome) {
        window.chrome = {};
      }
      window.chrome.runtime = window.chrome.runtime || {
        PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
        PlatformArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64' },
        connect: function() {},
        sendMessage: function() {},
      };
      window.chrome.loadTimes = window.chrome.loadTimes || function() {};
      window.chrome.csi = window.chrome.csi || function() {};
      window.chrome.app = window.chrome.app || { isInstalled: false };

      // 3. Mock languages to realistic Indian desktop browser
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-IN', 'en-GB', 'en-US', 'en', 'hi'],
        configurable: true,
      });

      // 4. Mock hardware concurrency and memory
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });

      // 5. Mock WebGL Vendor & Renderer to mask SwiftShader/llvmpipe
      const getParameterProto = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(param) {
        if (param === 0x9245) return 'Google Inc. (Intel)';
        if (param === 0x9246) return 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)';
        return getParameterProto.apply(this, arguments);
      };
      if (typeof WebGL2RenderingContext !== 'undefined') {
        const getParameterProto2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function(param) {
          if (param === 0x9245) return 'Google Inc. (Intel)';
          if (param === 0x9246) return 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)';
          return getParameterProto2.apply(this, arguments);
        };
      }

      // 6. Fix screen dimensions
      window.screen.availWidth = 1280;
      window.screen.availHeight = 720;
    });

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

        log(wrappedSend, '[zepto.daily] Stage 1 complete. Enforcing 5s cooldown before Stage 2...');
        await new Promise((resolve) => setTimeout(resolve, 5000));
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

    // If page is still accessible, capture diagnostic screenshot
    try {
      if (page && !page.isClosed()) {
        const currentUrl = page.url();
        log(wrappedSend, `[zepto.diag] Failure URL: ${currentUrl}`);
        const screenshotBuf = await page.screenshot({ fullPage: false }).catch(() => null);
        if (screenshotBuf) {
          wrappedSend('frame', {
            data: screenshotBuf.toString('base64'),
            source: 'failure_diagnostics',
          });
        }
      }
    } catch {}

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
      try {
        if (page && !page.isClosed() && await isLoggedIn(page)) {
          await saveZeptoSession(context, page, () => {});
        }
      } catch {}
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
  saveZeptoSession,
  loadSavedSessionState,
  getZeptoSessionStatus,
};
