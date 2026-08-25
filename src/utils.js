/**
 * Shared helpers: resilient click/fill wrappers with human-like pacing
 * (random delays + per-character typing), ported from utils.py.
 *
 * Logging: instead of a separate JSON log file, every step is streamed to
 * the browser via `send('log', ...)` and also printed to stdout, which
 * Cloud Run/`gcloud run logs` captures automatically — no local log file
 * needed (Cloud Run's filesystem doesn't persist between runs anyway).
 */
const { settings } = require('./config');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(send, step, message) {
  const line = `[${step}] ${message}`;
  console.log(line);
  send('log', { message: line });
}

function warn(send, step, message) {
  const line = `[${step}] WARNING: ${message}`;
  console.warn(line);
  send('log', { message: line });
}

function isXPath(selector) {
  const s = selector.trimStart();
  return s.startsWith('//') || s.startsWith('(') || s.startsWith('/');
}

function locatorFor(page, selector) {
  return isXPath(selector) ? page.locator(`xpath=${selector}`) : page.locator(selector);
}

function randomInt(lo, hi) {
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

async function humanPause(send, step, minMs, maxMs) {
  const lo = minMs ?? settings.HUMAN_PAUSE_MIN_MS;
  const hi = maxMs ?? settings.HUMAN_PAUSE_MAX_MS;
  await sleep(randomInt(lo, hi));
}

async function stepPause(send, step) {
  await humanPause(send, step, settings.STEP_PAUSE_MIN_MS, settings.STEP_PAUSE_MAX_MS);
}

async function humanTypeInto(locator, value) {
  await locator.click();
  for (const ch of value) {
    await locator.pressSequentially(ch, { delay: 0 });
    await sleep(randomInt(settings.TYPING_DELAY_MIN_MS, settings.TYPING_DELAY_MAX_MS));
  }
}

// Waits up to timeoutMs for the element to become visible; returns false
// instead of throwing if it never shows up (unlike Locator.isVisible(),
// which checks immediately with no wait).
async function waitVisibleQuick(page, selector, timeoutMs = 3000) {
  try {
    await locatorFor(page, selector).first().waitFor({ state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function safeClick(page, primarySelector, fallbackSelector, step, send, timeoutMs) {
  const timeout = timeoutMs ?? settings.ELEMENT_TIMEOUT_MS;
  await humanPause(send, step);

  try {
    const loc = locatorFor(page, primarySelector).first();
    await loc.waitFor({ state: 'visible', timeout });
    await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
    await loc.hover();
    await humanPause(send, step, 120, 320);
    await loc.click();
    log(send, step, `Clicked element (primary): ${primarySelector}`);
    return;
  } catch (primaryErr) {
    warn(send, step, `Primary selector failed, trying fallback: ${primaryErr.message}`);
  }

  if (!fallbackSelector) {
    throw new Error(`[${step}] Primary selector failed and no fallback provided: ${primarySelector}`);
  }

  try {
    const loc = locatorFor(page, fallbackSelector).first();
    await loc.waitFor({ state: 'visible', timeout });
    await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
    await loc.hover();
    await humanPause(send, step, 120, 320);
    await loc.click();
    log(send, step, `Clicked element (fallback): ${fallbackSelector}`);
  } catch (fbErr) {
    throw new Error(
      `[${step}] Both primary and fallback selectors failed. Primary: ${primarySelector} | Fallback: ${fallbackSelector} | Error: ${fbErr.message}`
    );
  }
}

async function safeFill(page, primarySelector, fallbackSelector, value, step, send, timeoutMs, mask = false) {
  const timeout = timeoutMs ?? settings.ELEMENT_TIMEOUT_MS;
  const displayValue = mask ? '***' : value;
  await humanPause(send, step);

  try {
    const loc = locatorFor(page, primarySelector).first();
    await loc.waitFor({ state: 'visible', timeout });
    await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
    await loc.fill('');
    await humanTypeInto(loc, value);
    log(send, step, `Typed into input (primary) value='${displayValue}'`);
    return;
  } catch (primaryErr) {
    warn(send, step, `Primary fill selector failed, trying fallback: ${primaryErr.message}`);
  }

  if (!fallbackSelector) {
    throw new Error(`[${step}] Fill failed, no fallback: ${primarySelector}`);
  }

  try {
    const loc = locatorFor(page, fallbackSelector).first();
    await loc.waitFor({ state: 'visible', timeout });
    await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
    await loc.fill('');
    await humanTypeInto(loc, value);
    log(send, step, `Typed into input (fallback) value='${displayValue}'`);
  } catch (fbErr) {
    throw new Error(
      `[${step}] Fill failed for both selectors. Primary: ${primarySelector} | Fallback: ${fallbackSelector} | Error: ${fbErr.message}`
    );
  }
}

async function screenshotOnError(page, step, send) {
  try {
    const safeStep = step.replace(/\./g, '_').replace(/\//g, '_');
    const path = require('path').join(settings.DOWNLOAD_DIR, `error_${safeStep}_${Date.now()}.png`);
    require('fs').mkdirSync(settings.DOWNLOAD_DIR, { recursive: true });
    await page.screenshot({ path, fullPage: true });
    warn(send, step, `Error screenshot saved: ${path}`);
    return path;
  } catch (shotErr) {
    warn(send, step, `Failed to capture error screenshot: ${shotErr.message}`);
    return null;
  }
}

module.exports = {
  sleep,
  log,
  warn,
  locatorFor,
  isXPath,
  humanPause,
  stepPause,
  humanTypeInto,
  waitVisibleQuick,
  safeClick,
  safeFill,
  screenshotOnError,
};
