const fs = require('fs');

// Shared by sheets.js and session.js: both authenticate as the same
// service account. GOOGLE_SERVICE_ACCOUNT_JSON is either a path to a
// key file (local dev) or the key JSON itself (Cloud Run secret).
function loadServiceAccountCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set.');
  }
  if (fs.existsSync(raw)) {
    return JSON.parse(fs.readFileSync(raw, 'utf8'));
  }
  return JSON.parse(raw);
}

module.exports = { loadServiceAccountCredentials };
