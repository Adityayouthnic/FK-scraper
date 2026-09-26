/**
 * Automated Cron Scheduler for FK-Scraper Suite
 *
 * Runs:
 *   - Wallet Scraper: Daily at configured time (default: 07:00 AM IST)
 *   - Search Trends Scraper: Weekly every Monday (default: 08:00 AM IST)
 *   - Zepto Sync: Daily at configured time (default: 14:00 / 2:00 PM IST)
 *
 * Runs directly in Node.js on Railway with Asia/Kolkata timezone support.
 */
const cron = require('node-cron');
const { settings } = require('./config');
const { runScrapeJob } = require('./scraper');
const { runTrendsJob } = require('./trendsScraper');
const { runZeptoJob } = require('./zeptoScraper');
const { sendAlert } = require('./alerts');

let schedulerInitialized = false;
let globalBroadcast = () => {};
let walletTask = null;
let trendsTask = null;
let zeptoTask = null;

let lastWalletRun = null;
let lastTrendsRun = null;
let lastZeptoRun = null;

let getSystemRunning = () => false;
let setSystemRunning = () => {};

/**
 * Helper to convert HH:MM string to cron expression.
 */
function timeToCron(timeStr, dayOfWeek = '*') {
  if (!timeStr) return null;
  const parts = String(timeStr).trim().split(':');
  if (parts.length < 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${m} ${h} * * ${dayOfWeek}`;
}

/**
 * Execute a job via the scheduler or API trigger.
 */
async function executeScheduledJob(jobName, options = {}, broadcast = globalBroadcast) {
  if (getSystemRunning()) {
    const skipMsg = `Scheduled auto-run for '${jobName}' deferred: another run is currently active.`;
    console.log(`[scheduler] ${skipMsg}`);
    broadcast('log', { message: skipMsg });
    return { success: false, skipped: true, message: skipMsg };
  }

  setSystemRunning(true, jobName);
  broadcast('status', { state: 'running', job: jobName, isAuto: true });

  const startTime = new Date().toISOString();
  console.log(`[scheduler] Starting auto-run for '${jobName}' at ${startTime}...`);
  broadcast('log', { message: `[scheduler] Starting automated run for '${jobName}'...` });

  const send = (type, payload = {}) => {
    broadcast(type, payload);
  };

  try {
    let result;
    if (jobName === 'trends') {
      result = await runTrendsJob(send, { ...options, unattended: true });
      lastTrendsRun = {
        time: new Date().toLocaleTimeString('en-IN', { timeZone: settings.CRON_TIMEZONE }),
        date: new Date().toLocaleDateString('en-IN', { timeZone: settings.CRON_TIMEZONE }),
        status: 'Success',
        rowsAdded: result.rowsAdded || 0,
        verticalsProcessed: result.verticalsProcessed || 0,
      };
      await sendAlert(
        'Search Trends Auto-Run Succeeded',
        `Automated run completed: ${result.verticalsProcessed} vertical(s) processed, ${result.rowsAdded} row(s) pushed to Google Sheets.`,
        { time: lastTrendsRun.time }
      );
    } else if (jobName === 'zepto') {
      result = await runZeptoJob(send, { ...options, unattended: true, action: options.action || 'daily' });
      lastZeptoRun = {
        time: new Date().toLocaleTimeString('en-IN', { timeZone: settings.CRON_TIMEZONE }),
        date: new Date().toLocaleDateString('en-IN', { timeZone: settings.CRON_TIMEZONE }),
        status: 'Success',
        action: options.action || 'daily',
        rowsProcessed: result.rowsProcessed || 0,
        datesProcessed: result.datesProcessed || 0,
      };
      await sendAlert(
        'Zepto Sync Auto-Run Succeeded',
        `Automated run completed: Zepto ${options.action || 'daily'} finished successfully.`,
        { time: lastZeptoRun.time }
      );
    } else {
      result = await runScrapeJob(send, { ...options, unattended: true });
      lastWalletRun = {
        time: new Date().toLocaleTimeString('en-IN', { timeZone: settings.CRON_TIMEZONE }),
        date: new Date().toLocaleDateString('en-IN', { timeZone: settings.CRON_TIMEZONE }),
        status: 'Success',
        rowsAdded: result.rowsAdded || 0,
        datesProcessed: result.datesProcessed || 0,
      };
      await sendAlert(
        'Wallet Scraper Auto-Run Succeeded',
        `Automated run completed: ${result.datesProcessed} date(s) processed, ${result.rowsAdded} row(s) pushed to Google Sheets.`,
        { time: lastWalletRun.time }
      );
    }

    send('done', { success: true, job: jobName, isAuto: true, ...result });
    return { success: true, ...result };
  } catch (err) {
    console.error(`[scheduler] Auto-run for '${jobName}' failed:`, err);
    send('error', { message: `Automated run failed: ${err.message}`, job: jobName });

    const isLoginError = err.message.toLowerCase().includes('login') || err.message.toLowerCase().includes('captcha') || err.message.toLowerCase().includes('otp');
    const runRecord = {
      time: new Date().toLocaleTimeString('en-IN', { timeZone: settings.CRON_TIMEZONE }),
      date: new Date().toLocaleDateString('en-IN', { timeZone: settings.CRON_TIMEZONE }),
      status: isLoginError ? 'Login Required' : 'Failed',
      error: err.message,
    };

    if (jobName === 'trends') lastTrendsRun = runRecord;
    else if (jobName === 'zepto') lastZeptoRun = runRecord;
    else lastWalletRun = runRecord;

    await sendAlert(
      isLoginError ? `${jobName} Login/OTP Required` : `${jobName} Auto-Run Failed`,
      isLoginError
        ? `${jobName} session expired or requires OTP/CAPTCHA during automated run. Please check the dashboard.`
        : `Automated run for ${jobName} failed with error: ${err.message}`,
      { time: runRecord.time }
    );

    return { success: false, error: err.message, isLoginError };
  } finally {
    setSystemRunning(false, null);
    broadcast('status', { state: 'idle' });
  }
}

/**
 * Configure and launch cron tasks.
 */
function setupCronTasks() {
  if (walletTask) {
    walletTask.stop();
    walletTask = null;
  }
  if (trendsTask) {
    trendsTask.stop();
    trendsTask = null;
  }
  if (zeptoTask) {
    zeptoTask.stop();
    zeptoTask = null;
  }

  if (!settings.ENABLE_AUTO_SCHEDULE) {
    console.log('[scheduler] Auto-scheduling is disabled.');
    return;
  }

  const tz = settings.CRON_TIMEZONE;

  // 1. Daily Wallet Scraper
  try {
    walletTask = cron.schedule(
      settings.WALLET_CRON_SCHEDULE,
      async () => {
        console.log(`[scheduler] Daily Wallet cron triggered (${settings.WALLET_CRON_SCHEDULE}) in ${tz}`);
        await executeScheduledJob('wallet', {}, globalBroadcast);
      },
      { timezone: tz }
    );
    console.log(`[scheduler] Wallet Scraper scheduled: '${settings.WALLET_CRON_SCHEDULE}' (${tz})`);
  } catch (err) {
    console.error(`[scheduler] Failed to schedule Wallet Scraper: ${err.message}`);
  }

  // 2. Weekly Search Trends (Mondays)
  try {
    trendsTask = cron.schedule(
      settings.TRENDS_CRON_SCHEDULE,
      async () => {
        console.log(`[scheduler] Weekly Search Trends cron triggered (${settings.TRENDS_CRON_SCHEDULE}) in ${tz}`);
        await executeScheduledJob('trends', { vertical: 'all', pages: settings.TRENDS_PAGES_PER_VERTICAL }, globalBroadcast);
      },
      { timezone: tz }
    );
    console.log(`[scheduler] Search Trends scheduled: '${settings.TRENDS_CRON_SCHEDULE}' (${tz})`);
  } catch (err) {
    console.error(`[scheduler] Failed to schedule Search Trends: ${err.message}`);
  }

  // 3. Daily Zepto Sync (14:00 IST)
  try {
    zeptoTask = cron.schedule(
      settings.ZEPTO_CRON_SCHEDULE,
      async () => {
        console.log(`[scheduler] Daily Zepto cron triggered (${settings.ZEPTO_CRON_SCHEDULE}) in ${tz}`);
        await executeScheduledJob('zepto', { action: 'daily' }, globalBroadcast);
      },
      { timezone: tz }
    );
    console.log(`[scheduler] Zepto Daily Sync scheduled: '${settings.ZEPTO_CRON_SCHEDULE}' (${tz})`);
  } catch (err) {
    console.error(`[scheduler] Failed to schedule Zepto Sync: ${err.message}`);
  }
}

/**
 * Initialize cron jobs for Wallet Scraper, Search Trends, and Zepto Sync.
 */
function initScheduler(broadcast, isRunningGetter, isRunningSetter) {
  if (schedulerInitialized) return;
  schedulerInitialized = true;

  if (broadcast) globalBroadcast = broadcast;
  if (isRunningGetter) getSystemRunning = isRunningGetter;
  if (isRunningSetter) setSystemRunning = isRunningSetter;

  setupCronTasks();
}

/**
 * Dynamically update schedule timings and restart cron tasks.
 */
function updateScheduleConfig({ enabled, walletTime, trendsTime, zeptoTime, walletSchedule, trendsSchedule, zeptoSchedule }) {
  if (enabled !== undefined) {
    settings.ENABLE_AUTO_SCHEDULE = Boolean(enabled);
  }

  if (walletTime) {
    const cronStr = timeToCron(walletTime, '*');
    if (cronStr) settings.WALLET_CRON_SCHEDULE = cronStr;
  } else if (walletSchedule) {
    settings.WALLET_CRON_SCHEDULE = walletSchedule;
  }

  if (trendsTime) {
    const cronStr = timeToCron(trendsTime, '1'); // 1 = Monday
    if (cronStr) settings.TRENDS_CRON_SCHEDULE = cronStr;
  } else if (trendsSchedule) {
    settings.TRENDS_CRON_SCHEDULE = trendsSchedule;
  }

  if (zeptoTime) {
    const cronStr = timeToCron(zeptoTime, '*');
    if (cronStr) settings.ZEPTO_CRON_SCHEDULE = cronStr;
  } else if (zeptoSchedule) {
    settings.ZEPTO_CRON_SCHEDULE = zeptoSchedule;
  }

  setupCronTasks();
  return getScheduleStatus();
}

/**
 * Return current scheduling information and run history.
 */
function getScheduleStatus() {
  return {
    enabled: settings.ENABLE_AUTO_SCHEDULE,
    timezone: settings.CRON_TIMEZONE,
    wallet: {
      schedule: settings.WALLET_CRON_SCHEDULE,
      description: 'Daily (7:00 AM IST by default)',
      lastRun: lastWalletRun,
    },
    trends: {
      schedule: settings.TRENDS_CRON_SCHEDULE,
      description: 'Weekly Mondays (8:00 AM IST by default)',
      lastRun: lastTrendsRun,
    },
    zepto: {
      schedule: settings.ZEPTO_CRON_SCHEDULE,
      description: 'Daily (2:00 PM IST / 14:00 IST by default)',
      lastRun: lastZeptoRun,
    },
  };
}

module.exports = {
  initScheduler,
  executeScheduledJob,
  getScheduleStatus,
  updateScheduleConfig,
};
