const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// The repo root — one level up from src/. Used so a relative key path in
// .env resolves the same way regardless of which directory `node` was
// launched from.
const PROJECT_ROOT = path.join(__dirname, '..');

let cachedOAuthClient = null;
let activeAuthInfo = null;

/**
 * Loads OAuth user credentials if available (e.g. from C:\Tools 2.0\Zepto_Auto_sale or env).
 */
function loadOAuthClient() {
  if (cachedOAuthClient) return cachedOAuthClient;

  let tokenData = null;
  let clientData = null;

  // 1. Check env variable GOOGLE_TOKEN_JSON (inline JSON or file path)
  const tokenEnv = (process.env.GOOGLE_TOKEN_JSON || '').trim();
  if (tokenEnv) {
    try {
      tokenData = tokenEnv.startsWith('{') ? JSON.parse(tokenEnv) : JSON.parse(fs.readFileSync(tokenEnv, 'utf8'));
    } catch (_) {}
  }

  // Fallback to local secrets/google_token.json or original tools path
  if (!tokenData) {
    const candidates = [
      path.join(PROJECT_ROOT, 'secrets', 'google_token.json'),
      'C:\\Tools 2.0\\Zepto_Auto_sale\\secrets\\google_token.json',
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        try {
          tokenData = JSON.parse(fs.readFileSync(p, 'utf8'));
          break;
        } catch (_) {}
      }
    }
  }

  // 2. Check env variable GOOGLE_OAUTH_CLIENT_JSON (inline JSON or file path)
  const clientEnv = (process.env.GOOGLE_OAUTH_CLIENT_JSON || '').trim();
  if (clientEnv) {
    try {
      clientData = clientEnv.startsWith('{') ? JSON.parse(clientEnv) : JSON.parse(fs.readFileSync(clientEnv, 'utf8'));
    } catch (_) {}
  }

  // Fallback to local secrets/oauth_credentials.json or original tools path
  if (!clientData) {
    const candidates = [
      path.join(PROJECT_ROOT, 'secrets', 'oauth_credentials.json'),
      'C:\\Tools 2.0\\Zepto_Auto_sale\\secrets\\oauth_credentials.json',
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        try {
          clientData = JSON.parse(fs.readFileSync(p, 'utf8'));
          break;
        } catch (_) {}
      }
    }
  }

  if (tokenData && (tokenData.token || tokenData.access_token || tokenData.refresh_token)) {
    const cfg = clientData?.installed || clientData?.web || {};
    const clientId = cfg.client_id || tokenData.client_id;
    const clientSecret = cfg.client_secret || tokenData.client_secret;
    const redirectUri = cfg.redirect_uris?.[0] || 'urn:ietf:wg:oauth:2.0:oob';

    const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    oAuth2Client.setCredentials({
      access_token: tokenData.token || tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      scope: Array.isArray(tokenData.scopes) ? tokenData.scopes.join(' ') : tokenData.scopes || 'https://www.googleapis.com/auth/spreadsheets',
      token_type: tokenData.token_type || 'Bearer',
      expiry_date: tokenData.expiry ? new Date(tokenData.expiry).getTime() : tokenData.expiry_date,
    });

    cachedOAuthClient = {
      type: 'oauth',
      identity: tokenData.account || clientId || 'OAuth User Token',
      client: oAuth2Client,
    };
    return cachedOAuthClient;
  }

  return null;
}

/**
 * Shared by sheets.js and session.js: authenticate as the service account.
 * GOOGLE_SERVICE_ACCOUNT_JSON is either a path to a key file (local dev) or the
 * key JSON itself (Cloud Run / Railway secret).
 */
function loadServiceAccountCredentials() {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();

  if (!raw) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_JSON is not set. In .env, point it at your key file, ' +
      'e.g. GOOGLE_SERVICE_ACCOUNT_JSON=./service-account.json'
    );
  }

  // Inline JSON — how the key arrives as a Cloud Run / Railway secret.
  if (raw.startsWith('{')) {
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `GOOGLE_SERVICE_ACCOUNT_JSON starts with "{" so it was treated as inline JSON, ` +
        `but it could not be parsed: ${err.message}`
      );
    }
  }

  // Otherwise it's a file path. Check the working directory first, then the project root.
  const candidates = [path.resolve(raw), path.resolve(PROJECT_ROOT, raw)];
  const found = candidates.find((p) => fs.existsSync(p));

  if (!found) {
    throw new Error(
      `Google service account key file not found.\n` +
      `  GOOGLE_SERVICE_ACCOUNT_JSON is set to: ${raw}\n` +
      `  Looked in:\n    ${candidates.join('\n    ')}\n` +
      `  Fix: download the JSON key, save it as service-account.json next to package.json, and share the Sheet with that service account's client_email.`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(found, 'utf8'));
  } catch (err) {
    throw new Error(`Service account key file at ${found} is not valid JSON: ${err.message}`);
  }

  if (!parsed.client_email || !parsed.private_key) {
    const hint = parsed.installed || parsed.web
      ? ' This looks like an OAuth client-secrets file, not a service account key.'
      : '';
    throw new Error(
      `The key file at ${found} is missing "client_email"/"private_key", so it isn't a ` +
      `service account key.${hint} Create a key from a Service Account instead.`
    );
  }

  return parsed;
}

/**
 * Returns the currently active Google identity (for clear logs and error messages).
 */
function getAuthIdentity() {
  if (activeAuthInfo) return activeAuthInfo;
  const oauth = loadOAuthClient();
  if (oauth) {
    activeAuthInfo = { type: 'oauth', identity: oauth.identity };
    return activeAuthInfo;
  }
  try {
    const creds = loadServiceAccountCredentials();
    activeAuthInfo = { type: 'service_account', identity: creds.client_email };
    return activeAuthInfo;
  } catch (_) {
    return { type: 'unknown', identity: 'unauthenticated' };
  }
}

let sheetsClientPromise = null;
function getSheetsClient() {
  if (!sheetsClientPromise) {
    sheetsClientPromise = (async () => {
      // 1. Prefer OAuth user token if available
      const oauth = loadOAuthClient();
      if (oauth) {
        activeAuthInfo = { type: 'oauth', identity: oauth.identity };
        return google.sheets({ version: 'v4', auth: oauth.client });
      }

      // 2. Otherwise use Service Account
      const credentials = loadServiceAccountCredentials();
      activeAuthInfo = { type: 'service_account', identity: credentials.client_email };
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      const client = await auth.getClient();
      return google.sheets({ version: 'v4', auth: client });
    })();
  }
  return sheetsClientPromise;
}

module.exports = {
  loadServiceAccountCredentials,
  getSheetsClient,
  getAuthIdentity,
  loadOAuthClient,
};
