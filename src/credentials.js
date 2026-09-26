/**
 * Credentials & System Settings Manager
 *
 * Persists Flipkart Seller credentials, Zepto credentials, Google Sheets IDs,
 * and Webhook alerts in data/credentials.json while falling back to environment variables.
 */

const fs = require('fs');
const path = require('path');
const { settings } = require('./config');

const CREDENTIALS_FILE = path.join(__dirname, '..', 'data', 'credentials.json');

let credentialsCache = null;

function loadCredentialsFile() {
  if (credentialsCache) return credentialsCache;

  let fileData = {};
  try {
    if (fs.existsSync(CREDENTIALS_FILE)) {
      fileData = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
    }
  } catch (err) {
    console.warn('[credentials] Could not read credentials.json, using defaults:', err.message);
  }

  credentialsCache = {
    // Flipkart credentials & settings
    flipkartEmail: fileData.flipkartEmail || process.env.FLIPKART_EMAIL || '',
    flipkartPassword: fileData.flipkartPassword || process.env.FLIPKART_PASSWORD || '',
    spreadsheetId: fileData.spreadsheetId || settings.SPREADSHEET_ID || '',
    trendsSpreadsheetId: fileData.trendsSpreadsheetId || settings.TRENDS_SPREADSHEET_ID || '',
    alertWebhookUrl: fileData.alertWebhookUrl || settings.ALERT_WEBHOOK_URL || '',
    apiAccessToken: fileData.apiAccessToken || process.env.ACCESS_TOKEN || '',

    // Zepto credentials & settings
    zeptoEmail: fileData.zeptoEmail || process.env.ZEPTO_EMAIL || '',
    zeptoPassword: fileData.zeptoPassword || process.env.ZEPTO_PASSWORD || '',
    zeptoImapHost: fileData.zeptoImapHost || process.env.IMAP_HOST || 'imap.gmail.com',
    zeptoImapUser: fileData.zeptoImapUser || process.env.IMAP_USER || '',
    zeptoImapPassword: fileData.zeptoImapPassword || process.env.IMAP_PASSWORD || '',
    zeptoNotifyTo: fileData.zeptoNotifyTo || process.env.NOTIFY_TO || '',
    zeptoSheetId: fileData.zeptoSheetId || process.env.GSHEET_ID || '',
    zeptoHeaded: fileData.zeptoHeaded !== undefined ? fileData.zeptoHeaded : (process.env.HEADED === '1'),
    zeptoPythonPath: fileData.zeptoPythonPath || process.env.PYTHON_PATH || '',
  };

  // Sync to runtime settings
  if (credentialsCache.spreadsheetId) settings.SPREADSHEET_ID = credentialsCache.spreadsheetId;
  if (credentialsCache.trendsSpreadsheetId) settings.TRENDS_SPREADSHEET_ID = credentialsCache.trendsSpreadsheetId;
  if (credentialsCache.alertWebhookUrl) settings.ALERT_WEBHOOK_URL = credentialsCache.alertWebhookUrl;
  if (credentialsCache.apiAccessToken) process.env.ACCESS_TOKEN = credentialsCache.apiAccessToken;

  return credentialsCache;
}

function saveCredentialsFile() {
  try {
    const dir = path.dirname(CREDENTIALS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentialsCache, null, 2), 'utf8');
  } catch (err) {
    console.error('[credentials] Failed to save credentials.json:', err.message);
  }
}

/**
 * Returns raw credentials (for internal scraper login use only).
 */
function getRawCredentials() {
  const creds = loadCredentialsFile();
  return {
    email: creds.flipkartEmail,
    password: creds.flipkartPassword,
  };
}

/**
 * Returns raw Zepto credentials for child process runner.
 */
function getRawZeptoCredentials() {
  const creds = loadCredentialsFile();
  return {
    email: creds.zeptoEmail,
    password: creds.zeptoPassword,
    imapHost: creds.zeptoImapHost,
    imapUser: creds.zeptoImapUser,
    imapPassword: creds.zeptoImapPassword,
    notifyTo: creds.zeptoNotifyTo,
    sheetId: creds.zeptoSheetId,
    headed: creds.zeptoHeaded ? '1' : '0',
    pythonPath: creds.zeptoPythonPath,
  };
}

/**
 * Returns masked settings for frontend display (never leaks plaintext passwords).
 */
function getSafeCredentials() {
  const creds = loadCredentialsFile();
  return {
    flipkartEmail: creds.flipkartEmail || '',
    hasFlipkartPassword: Boolean(creds.flipkartPassword),
    flipkartPasswordMasked: creds.flipkartPassword ? '••••••••••••' : '',
    spreadsheetId: creds.spreadsheetId || '',
    trendsSpreadsheetId: creds.trendsSpreadsheetId || '',
    alertWebhookUrl: creds.alertWebhookUrl || '',
    apiAccessToken: creds.apiAccessToken || '',

    // Zepto safe settings
    zeptoEmail: creds.zeptoEmail || '',
    hasZeptoPassword: Boolean(creds.zeptoPassword),
    zeptoPasswordMasked: creds.zeptoPassword ? '••••••••••••' : '',
    zeptoImapHost: creds.zeptoImapHost || 'imap.gmail.com',
    zeptoImapUser: creds.zeptoImapUser || '',
    hasZeptoImapPassword: Boolean(creds.zeptoImapPassword),
    zeptoImapPasswordMasked: creds.zeptoImapPassword ? '••••••••••••' : '',
    zeptoNotifyTo: creds.zeptoNotifyTo || '',
    zeptoSheetId: creds.zeptoSheetId || '',
    zeptoHeaded: Boolean(creds.zeptoHeaded),
    zeptoPythonPath: creds.zeptoPythonPath || '',
  };
}

/**
 * Update system credentials and settings from dashboard.
 */
function updateCredentials(updates = {}) {
  const creds = loadCredentialsFile();

  // Flipkart
  if (typeof updates.flipkartEmail === 'string') {
    creds.flipkartEmail = updates.flipkartEmail.trim();
    process.env.FLIPKART_EMAIL = creds.flipkartEmail;
  }

  if (typeof updates.flipkartPassword === 'string' && updates.flipkartPassword.trim() && !updates.flipkartPassword.includes('••••')) {
    creds.flipkartPassword = updates.flipkartPassword;
    process.env.FLIPKART_PASSWORD = creds.flipkartPassword;
  }

  if (typeof updates.spreadsheetId === 'string') {
    creds.spreadsheetId = updates.spreadsheetId.trim();
    settings.SPREADSHEET_ID = creds.spreadsheetId;
  }

  if (typeof updates.trendsSpreadsheetId === 'string') {
    creds.trendsSpreadsheetId = updates.trendsSpreadsheetId.trim();
    settings.TRENDS_SPREADSHEET_ID = creds.trendsSpreadsheetId;
  }

  if (typeof updates.alertWebhookUrl === 'string') {
    creds.alertWebhookUrl = updates.alertWebhookUrl.trim();
    settings.ALERT_WEBHOOK_URL = creds.alertWebhookUrl;
  }

  if (typeof updates.apiAccessToken === 'string') {
    creds.apiAccessToken = updates.apiAccessToken.trim();
    process.env.ACCESS_TOKEN = creds.apiAccessToken;
  }

  // Zepto
  if (typeof updates.zeptoEmail === 'string') {
    creds.zeptoEmail = updates.zeptoEmail.trim();
    process.env.ZEPTO_EMAIL = creds.zeptoEmail;
  }

  if (typeof updates.zeptoPassword === 'string' && updates.zeptoPassword.trim() && !updates.zeptoPassword.includes('••••')) {
    creds.zeptoPassword = updates.zeptoPassword;
    process.env.ZEPTO_PASSWORD = creds.zeptoPassword;
  }

  if (typeof updates.zeptoImapHost === 'string') {
    creds.zeptoImapHost = updates.zeptoImapHost.trim();
    process.env.IMAP_HOST = creds.zeptoImapHost;
  }

  if (typeof updates.zeptoImapUser === 'string') {
    creds.zeptoImapUser = updates.zeptoImapUser.trim();
    process.env.IMAP_USER = creds.zeptoImapUser;
  }

  if (typeof updates.zeptoImapPassword === 'string' && updates.zeptoImapPassword.trim() && !updates.zeptoImapPassword.includes('••••')) {
    creds.zeptoImapPassword = updates.zeptoImapPassword.replace(/\s+/g, '');
    process.env.IMAP_PASSWORD = creds.zeptoImapPassword;
  }

  if (typeof updates.zeptoNotifyTo === 'string') {
    creds.zeptoNotifyTo = updates.zeptoNotifyTo.trim();
    process.env.NOTIFY_TO = creds.zeptoNotifyTo;
  }

  if (typeof updates.zeptoSheetId === 'string') {
    creds.zeptoSheetId = updates.zeptoSheetId.trim();
    process.env.GSHEET_ID = creds.zeptoSheetId;
  }

  if (updates.zeptoHeaded !== undefined) {
    creds.zeptoHeaded = Boolean(updates.zeptoHeaded);
    process.env.HEADED = creds.zeptoHeaded ? '1' : '0';
  }

  if (typeof updates.zeptoPythonPath === 'string') {
    creds.zeptoPythonPath = updates.zeptoPythonPath.trim();
    process.env.PYTHON_PATH = creds.zeptoPythonPath;
  }

  saveCredentialsFile();
  return getSafeCredentials();
}

module.exports = {
  getRawCredentials,
  getRawZeptoCredentials,
  getSafeCredentials,
  updateCredentials,
};
