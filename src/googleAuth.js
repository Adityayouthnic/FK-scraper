const fs = require('fs');
const path = require('path');

// The repo root — one level up from src/. Used so a relative key path in
// .env resolves the same way regardless of which directory `node` was
// launched from.
const PROJECT_ROOT = path.join(__dirname, '..');

// Shared by sheets.js and session.js: both authenticate as the same
// service account. GOOGLE_SERVICE_ACCOUNT_JSON is either a path to a key
// file (local dev) or the key JSON itself (Cloud Run mounted secret).
function loadServiceAccountCredentials() {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();

  if (!raw) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_JSON is not set. In .env, point it at your key file, ' +
      'e.g. GOOGLE_SERVICE_ACCOUNT_JSON=./service-account.json'
    );
  }

  // Inline JSON — how the key arrives as a Cloud Run secret.
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

  // Otherwise it's a file path. Check the working directory first, then the
  // project root.
  const candidates = [path.resolve(raw), path.resolve(PROJECT_ROOT, raw)];
  const found = candidates.find((p) => fs.existsSync(p));

  if (!found) {
    // Without this branch the path string itself fell through to
    // JSON.parse, producing a baffling "Unexpected token '.'" instead of
    // saying the obvious thing: the key file isn't there.
    throw new Error(
      `Google service account key file not found.\n` +
      `  GOOGLE_SERVICE_ACCOUNT_JSON is set to: ${raw}\n` +
      `  Looked in:\n    ${candidates.join('\n    ')}\n` +
      `  Fix: download the JSON key (Google Cloud Console > IAM & Admin > Service Accounts > ` +
      `your account > Keys > Add Key > Create new key > JSON), save it as service-account.json ` +
      `next to package.json, and share the Sheet with that service account's client_email.`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(found, 'utf8'));
  } catch (err) {
    throw new Error(`Service account key file at ${found} is not valid JSON: ${err.message}`);
  }

  // Fail loudly on the wrong kind of JSON (an OAuth "installed app" client
  // secrets file is the easy mix-up) rather than deep inside googleapis.
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

module.exports = { loadServiceAccountCredentials };
