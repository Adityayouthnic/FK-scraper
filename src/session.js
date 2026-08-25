/**
 * Persists the logged-in Flipkart session (cookies/localStorage) to a
 * Google Cloud Storage bucket between runs, so most runs can skip login
 * entirely. Falls back cleanly (returns null / logs a warning) if no
 * bucket is configured yet, so the app still works via interactive login
 * alone before you've set this up.
 */
const { Storage } = require('@google-cloud/storage');
const { settings } = require('./config');
const { loadServiceAccountCredentials } = require('./googleAuth');
const { log, warn } = require('./utils');

let storageClient = null;
function getStorageClient() {
  if (!storageClient) {
    storageClient = new Storage({ credentials: loadServiceAccountCredentials() });
  }
  return storageClient;
}

async function loadSession(send) {
  if (!settings.SESSION_BUCKET) {
    log(send, 'session.load', 'No SESSION_BUCKET configured — skipping saved session, will log in fresh.');
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
  if (!settings.SESSION_BUCKET) return;
  try {
    const state = await context.storageState();
    const file = getStorageClient().bucket(settings.SESSION_BUCKET).file(settings.SESSION_OBJECT);
    await file.save(JSON.stringify(state), { contentType: 'application/json' });
    log(send, 'session.save', 'Saved session to Cloud Storage for future runs.');
  } catch (err) {
    warn(send, 'session.save', `Could not save session (${err.message}) — next run will log in fresh.`);
  }
}

module.exports = { loadSession, saveSession };
