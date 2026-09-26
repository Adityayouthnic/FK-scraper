/**
 * Persists the logged-in Flipkart session (cookies/localStorage) to a
 * Google Cloud Storage bucket between runs, so most runs can skip login
 * entirely. Falls back cleanly (returns null / logs a warning) if no
 * bucket is configured yet, so the app still works via interactive login
 * alone before you've set this up.
 */
const fs = require('fs');
const path = require('path');
const { Storage } = require('@google-cloud/storage');
const { settings } = require('./config');
const { loadServiceAccountCredentials } = require('./googleAuth');
const { log, warn } = require('./utils');

const PROJECT_ROOT = path.join(__dirname, '..');

let storageClient = null;
let inMemorySession = null;

function getStorageClient() {
  if (!storageClient) {
    storageClient = new Storage({ credentials: loadServiceAccountCredentials() });
  }
  return storageClient;
}

function getLocalSessionPath() {
  const mainPath = path.join(PROJECT_ROOT, settings.SESSION_OBJECT || 'flipkart-session.json');
  if (fs.existsSync(mainPath)) return mainPath;
  const altPath = path.join(PROJECT_ROOT, 'fk_auth_state.json');
  if (fs.existsSync(altPath)) return altPath;
  return mainPath;
}

async function loadSession(send) {
  if (inMemorySession) {
    log(send, 'session.load', 'Loaded session from in-memory cache.');
    return inMemorySession;
  }
  if (!settings.SESSION_BUCKET) {
    const localPath = getLocalSessionPath();
    if (fs.existsSync(localPath)) {
      try {
        const contents = fs.readFileSync(localPath, 'utf8');
        log(send, 'session.load', `Loaded saved session from local file (${path.basename(localPath)}).`);
        inMemorySession = JSON.parse(contents);
        return inMemorySession;
      } catch (err) {
        warn(send, 'session.load', `Could not parse local session file (${err.message}) — will log in fresh.`);
        return null;
      }
    }
    warn(
      send,
      'session.load',
      'No SESSION_BUCKET configured and no local session found — a fresh login/CAPTCHA will be required.'
    );
    return null;
  }
  try {
    const file = getStorageClient().bucket(settings.SESSION_BUCKET).file(settings.SESSION_OBJECT);
    const [exists] = await file.exists();
    if (!exists) {
      log(send, 'session.load', 'No saved session found in bucket yet — will log in fresh.');
      return null;
    }
    const [contents] = await file.download();
    log(send, 'session.load', 'Loaded saved session from Cloud Storage.');
    return JSON.parse(contents.toString('utf8'));
  } catch (err) {
    warn(send, 'session.load', `Could not load saved session (${err.message}) — will log in fresh.`);
    return null;
  }
}

async function saveSession(context, send) {
  try {
    const state = await context.storageState();
    inMemorySession = state;
    if (settings.SESSION_BUCKET) {
      const file = getStorageClient().bucket(settings.SESSION_BUCKET).file(settings.SESSION_OBJECT);
      await file.save(JSON.stringify(state), { contentType: 'application/json' });
      log(send, 'session.save', 'Saved session to Cloud Storage for future runs.');
    } else {
      const localPath = path.join(PROJECT_ROOT, settings.SESSION_OBJECT || 'flipkart-session.json');
      fs.writeFileSync(localPath, JSON.stringify(state, null, 2), 'utf8');
      log(send, 'session.save', `Saved session to local file (${path.basename(localPath)}) for future runs.`);
    }
  } catch (err) {
    warn(send, 'session.save', `Could not save session (${err.message}) — next run will log in fresh.`);
  }
}

module.exports = { loadSession, saveSession };
