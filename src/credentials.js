/**
 * Credentials & System Settings Manager
 *
 * Persists Flipkart Seller credentials, Google Sheets IDs, and Webhook alerts
 * in data/credentials.json while falling back to environment variables.
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
    flipkartEmail: fileData.flipkartEmail || process.env.FLIPKART_EMAIL || '',
    flipkartPassword: fileData.flipkartPassword || process.env.FLIPKART_PASSWORD || '',
    spreadsheetId: fileData.spreadsheetId || settings.SPREADSHEET_ID || '',
    trendsSpreadsheetId: fileData.trendsSpreadsheetId || settings.TRENDS_SPREADSHEET_ID || '',
    alertWebhookUrl: fileData.alertWebhookUrl || settings.ALERT_WEBHOOK_URL || '',
    apiAccessToken: fileData.apiAccessToken || process.env.ACCESS_TOKEN || '',
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
 * Returns masked settings for frontend display (never leaks plaintext password).
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
  };
}

/**
 * Update system credentials and settings from dashboard.
 */
function updateCredentials(updates = {}) {
  const creds = loadCredentialsFile();

  if (typeof updates.flipkartEmail === 'string') {
    creds.flipkartEmail = updates.flipkartEmail.trim();
    process.env.FLIPKART_EMAIL = creds.flipkartEmail;
  }

  // Only update password if provided and not the masked placeholder
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

  saveCredentialsFile();
  return getSafeCredentials();
}

module.exports = {
  getRawCredentials,
  getSafeCredentials,
  updateCredentials,
};
