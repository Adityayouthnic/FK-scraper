const path = require('path');

function int(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

const settings = {
  WALLET_URL: process.env.WALLET_URL ||
    'https://seller.flipkart.com/index.html#dashboard/ads/wallet/summary',

  // How many recent calendar days (ending yesterday) to check for gaps and
  // backfill on each run. Adjust to match how often you actually click Run.
  LOOKBACK_DAYS: int('LOOKBACK_DAYS', 7),

  SPREADSHEET_ID: process.env.GOOGLE_SHEET_ID || '',
  SHEET_NAME: process.env.GOOGLE_SHEET_NAME || 'Sheet1',

  // GCS bucket + object name used to persist the logged-in session
  // (cookies/localStorage) between runs, so most runs can skip login.
  SESSION_BUCKET: process.env.SESSION_BUCKET || '',
  SESSION_OBJECT: process.env.SESSION_OBJECT || 'flipkart-session.json',

  HEADLESS: true,
  BROWSER_CHANNEL: process.env.BROWSER_CHANNEL || null,
  VIEWPORT_WIDTH: int('VIEWPORT_WIDTH', 1024),
  VIEWPORT_HEIGHT: int('VIEWPORT_HEIGHT', 768),

  ELEMENT_TIMEOUT_MS: int('ELEMENT_TIMEOUT_MS', 20000),
  PAGE_LOAD_TIMEOUT_MS: int('PAGE_LOAD_TIMEOUT_MS', 45000),
  DATA_LOAD_WAIT_MS: int('DATA_LOAD_WAIT_MS', 3000),
  DOWNLOAD_TIMEOUT_MS: int('DOWNLOAD_TIMEOUT_MS', 30000),

  HUMAN_PAUSE_MIN_MS: int('HUMAN_PAUSE_MIN_MS', 300),
  HUMAN_PAUSE_MAX_MS: int('HUMAN_PAUSE_MAX_MS', 900),
  STEP_PAUSE_MIN_MS: int('STEP_PAUSE_MIN_MS', 800),
  STEP_PAUSE_MAX_MS: int('STEP_PAUSE_MAX_MS', 1800),
  TYPING_DELAY_MIN_MS: int('TYPING_DELAY_MIN_MS', 60),
  TYPING_DELAY_MAX_MS: int('TYPING_DELAY_MAX_MS', 160),

  DOWNLOAD_DIR: process.env.DOWNLOAD_DIR || path.join('/tmp', 'fk-scraper-downloads'),
};

module.exports = { settings };
