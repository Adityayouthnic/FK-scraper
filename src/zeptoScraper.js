/**
 * Zepto Portal Automation Runner
 *
 * Drives Zepto automation engine (Sales Sync, FC Inventory, Report Downloads, Login/OTP)
 * and streams real-time stdout/stderr logs and screenshots over WebSocket.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getRawZeptoCredentials } = require('./credentials');
const { log, warn } = require('./utils');
const {
  RunCancelledError,
  createRunContext,
  clearActiveRun,
} = require('./runner');
const { sendAlert } = require('./alerts');

const ENGINE_DIR = path.join(__dirname, '..', 'zepto_engine');
const LEGACY_DIR = 'C:\\Tools 2.0\\Zepto_Auto_sale';

/**
 * Finds the appropriate Python executable.
 */
function resolvePythonPath(customPath) {
  if (customPath && fs.existsSync(customPath)) {
    return customPath;
  }

  // 1. Windows default project virtual environment
  const venvPythonWin = path.join(LEGACY_DIR, '.venv', 'Scripts', 'python.exe');
  if (fs.existsSync(venvPythonWin)) {
    return venvPythonWin;
  }

  // 2. Local zepto_engine virtualenv if created
  const localVenvWin = path.join(ENGINE_DIR, '.venv', 'Scripts', 'python.exe');
  if (fs.existsSync(localVenvWin)) {
    return localVenvWin;
  }

  const localVenvUnix = path.join(ENGINE_DIR, '.venv', 'bin', 'python');
  if (fs.existsSync(localVenvUnix)) {
    return localVenvUnix;
  }

  // 3. Environment or system python
  if (process.env.PYTHON_PATH) {
    return process.env.PYTHON_PATH;
  }

  return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * Resolves working directory for the Zepto scripts.
 */
function resolveEngineDir() {
  if (fs.existsSync(ENGINE_DIR) && fs.existsSync(path.join(ENGINE_DIR, 'config.py'))) {
    return ENGINE_DIR;
  }
  if (fs.existsSync(LEGACY_DIR)) {
    return LEGACY_DIR;
  }
  return ENGINE_DIR;
}

/**
 * Runs a Zepto automation job.
 *
 * @param {Function} send - WebSocket message dispatcher
 * @param {Object} options - Job configuration options
 * @returns {Promise<Object>} Run summary
 */
async function runZeptoJob(send, options = {}) {
  const creds = getRawZeptoCredentials();
  const pythonPath = resolvePythonPath(creds.pythonPath || options.pythonPath);
  const workDir = resolveEngineDir();
  const action = options.action || options.module || 'daily';

  log(send, `[zepto] Initializing Zepto Engine (action: ${action})...`);
  log(send, `[zepto] Python Runtime: ${pythonPath}`);
  log(send, `[zepto] Working Directory: ${workDir}`);

  // Build Python command arguments
  const scriptArgs = [];

  switch (action) {
    case 'daily':
    case 'run_daily':
      scriptArgs.push('run_daily.py');
      if (options.headed || creds.headed === '1') {
        scriptArgs.push('--headed');
      }
      break;

    case 'sales':
    case 'sheet_pipeline':
      scriptArgs.push('sheet_pipeline.py', '--from-portal');
      if (options.days) scriptArgs.push('--days', String(options.days));
      if (options.from) scriptArgs.push('--from', String(options.from));
      if (options.to) scriptArgs.push('--to', String(options.to));
      if (options.dryRun) scriptArgs.push('--dry-run');
      break;

    case 'inventory':
    case 'inventory_pipeline':
      scriptArgs.push('inventory_pipeline.py', '--from-portal');
      if (options.dryRun) scriptArgs.push('--dry-run');
      if (options.date) scriptArgs.push('--date', String(options.date));
      break;

    case 'login':
    case 'auth':
      scriptArgs.push('zepto_login.py');
      if (options.mode === 'setup') {
        scriptArgs.push('--setup');
      } else {
        scriptArgs.push('--auto');
      }
      break;

    case 'download':
    case 'download_report':
      scriptArgs.push('download_report.py');
      if (options.reportType) scriptArgs.push('--type', String(options.reportType));
      if (options.from) scriptArgs.push('--from', String(options.from));
      if (options.to) scriptArgs.push('--to', String(options.to));
      if (options.force) scriptArgs.push('--force');
      if (options.noSave) scriptArgs.push('--no-save');
      break;

    case 'test_alert':
      scriptArgs.push('notify.py', '--test');
      break;

    default:
      log(send, `[zepto] Defaulting to daily full sync.`);
      scriptArgs.push('run_daily.py');
      if (options.headed || creds.headed === '1') {
        scriptArgs.push('--headed');
      }
      break;
  }

  // Setup environment for the child process
  const env = {
    ...process.env,
    ZEPTO_EMAIL: creds.email || process.env.ZEPTO_EMAIL || '',
    ZEPTO_PASSWORD: creds.password || process.env.ZEPTO_PASSWORD || '',
    IMAP_HOST: creds.imapHost || process.env.IMAP_HOST || 'imap.gmail.com',
    IMAP_USER: creds.imapUser || process.env.IMAP_USER || '',
    IMAP_PASSWORD: creds.imapPassword || process.env.IMAP_PASSWORD || '',
    GSHEET_ID: creds.sheetId || process.env.GSHEET_ID || '',
    HEADED: options.headed !== undefined ? (options.headed ? '1' : '0') : (creds.headed || '0'),
    NOTIFY_TO: creds.notifyTo || process.env.NOTIFY_TO || '',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  };

  const ctx = createRunContext('zepto');

  // Monitor logs folder for screenshot updates to stream visually to Live View
  const logsDir = path.join(workDir, 'logs');
  if (!fs.existsSync(logsDir)) {
    try { fs.mkdirSync(logsDir, { recursive: true }); } catch {}
  }

  let screenshotInterval = null;
  let lastScreenshotTime = 0;

  function checkForScreenshots() {
    try {
      if (!fs.existsSync(logsDir)) return;
      const files = fs.readdirSync(logsDir);
      for (const file of files) {
        if (!file.endsWith('.png')) continue;
        const filePath = path.join(logsDir, file);
        const stats = fs.statSync(filePath);
        if (stats.mtimeMs > lastScreenshotTime) {
          lastScreenshotTime = stats.mtimeMs;
          const imageBase64 = fs.readFileSync(filePath).toString('base64');
          send('frame', {
            data: imageBase64,
            viewportWidth: 1024,
            viewportHeight: 768,
            source: file,
          });
          log(send, `[zepto.view] Displaying updated portal snapshot: ${file}`);
        }
      }
    } catch {}
  }

  screenshotInterval = setInterval(checkForScreenshots, 2000);

  return new Promise((resolve, reject) => {
    let outputBuffer = '';
    let rowsProcessed = 0;
    let datesProcessed = 0;

    log(send, `[zepto] Executing: ${pythonPath} -u ${scriptArgs.join(' ')}`);

    const proc = spawn(pythonPath, ['-u', ...scriptArgs], {
      cwd: workDir,
      env,
      shell: false,
    });

    ctx.process = proc;

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      outputBuffer += text;

      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Extract key metrics if present
        const rowsMatch = trimmed.match(/(?:appending|transformed|writing)\s+(\d+)\s+rows/i);
        if (rowsMatch) rowsProcessed = Math.max(rowsProcessed, parseInt(rowsMatch[1], 10));

        const datesMatch = trimmed.match(/dates:\s*\[(.*?)\]/i);
        if (datesMatch) {
          const count = datesMatch[1].split(',').filter(Boolean).length;
          datesProcessed = Math.max(datesProcessed, count);
        }

        log(send, trimmed);
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) warn(send, trimmed);
      }
    });

    proc.on('error', (err) => {
      clearInterval(screenshotInterval);
      clearActiveRun(ctx);
      warn(send, `[zepto] Failed to spawn process: ${err.message}`);
      reject(err);
    });

    proc.on('close', async (code) => {
      clearInterval(screenshotInterval);
      clearActiveRun(ctx);
      checkForScreenshots(); // final check for any closing snapshot

      if (ctx.cancelled) {
        log(send, '[zepto] Run was cancelled by user.');
        reject(new RunCancelledError());
        return;
      }

      if (code === 0) {
        log(send, `[zepto] Run completed successfully (exit code: 0).`);
        resolve({
          success: true,
          portal: 'Zepto',
          action,
          rowsProcessed,
          datesProcessed,
          message: `Zepto ${action} automation finished successfully.`,
        });
      } else {
        const errMsg = `Zepto ${action} exited with non-zero code ${code}.`;
        warn(send, `[zepto] ${errMsg}`);
        reject(new Error(errMsg));
      }
    });
  });
}

module.exports = {
  runZeptoJob,
  resolvePythonPath,
  resolveEngineDir,
};
