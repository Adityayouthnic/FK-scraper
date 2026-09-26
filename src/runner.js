const { settings } = require('./config');

const VIEWPORT = { width: settings.VIEWPORT_WIDTH, height: settings.VIEWPORT_HEIGHT };

let activePage = null;
let activeRun = null;
let activeJob = null;

class RunCancelledError extends Error {
  constructor() {
    super('Run cancelled by user.');
    this.code = 'RUN_CANCELLED';
  }
}

function getActiveRun() {
  return activeRun;
}

function getActiveJob() {
  return activeJob;
}

function getActivePage() {
  return activePage;
}

function setActivePage(page) {
  activePage = page;
}

function clearActivePage(page) {
  if (activePage === page || !page) {
    activePage = null;
  }
}

function clearActiveRun(run) {
  if (activeRun === run || !run) {
    activeRun = null;
    activeJob = null;
  }
}

function cancelActiveRun() {
  if (!activeRun) return false;

  activeRun.cancelled = true;

  // Immediately close active Playwright page/context/browser to abort in-flight operations
  if (activeRun.page && typeof activeRun.page.close === 'function') {
    try {
      activeRun.page.close().catch(() => {});
    } catch {}
  }
  if (activeRun.context && typeof activeRun.context.close === 'function') {
    try {
      activeRun.context.close().catch(() => {});
    } catch {}
  }
  if (activeRun.browser && activeRun.browser !== activeRun.context && typeof activeRun.browser.close === 'function') {
    try {
      activeRun.browser.close().catch(() => {});
    } catch {}
  }

  if (activeRun.process) {
    try {
      if (process.platform === 'win32') {
        const { execSync } = require('child_process');
        execSync(`taskkill /pid ${activeRun.process.pid} /T /F`);
      } else {
        activeRun.process.kill('SIGKILL');
      }
    } catch {}
  }
  if (activeRun.rejectCancel) {
    try {
      activeRun.rejectCancel(new RunCancelledError());
    } catch {}
  }
  return true;
}

function awaitCancellable(run, operation, onLateResolve) {
  const pending = Promise.resolve(operation);
  pending.then((value) => {
    // If cancellation won while a setup operation was still starting, clean
    // up anything that finished after the run had already been released.
    if (run.cancelled && onLateResolve) onLateResolve(value);
  }, () => {});
  return Promise.race([pending, run.cancelPromise]);
}

async function dispatchInput(evt) {
  if (!activePage) return;
  try {
    switch (evt.event) {
      case 'mousemove':
        await activePage.mouse.move(evt.x, evt.y);
        break;
      case 'mousedown':
        await activePage.mouse.move(evt.x, evt.y);
        await activePage.mouse.down({ button: evt.button || 'left' });
        break;
      case 'mouseup':
        await activePage.mouse.up({ button: evt.button || 'left' });
        break;
      case 'wheel':
        await activePage.mouse.wheel(evt.deltaX || 0, evt.deltaY || 0);
        break;
      case 'keydown':
        await activePage.keyboard.down(evt.key);
        break;
      case 'keyup':
        await activePage.keyboard.up(evt.key);
        break;
      default:
        break;
    }
  } catch {
    // Page may be mid-navigation when an input event arrives; drop it.
  }
}

function createRunContext(jobName = 'wallet') {
  const run = {
    browser: null,
    context: null,
    page: null,
    cancelled: false,
    rejectCancel: null,
    resolveCancel: null,
    jobName,
  };
  run.cancelPromise = new Promise((resolve, reject) => {
    run.resolveCancel = resolve;
    run.rejectCancel = reject;
  });
  activeRun = run;
  activeJob = jobName;
  return run;
}

async function setupScreencast(run, context, page, send) {
  const client = await awaitCancellable(run, context.newCDPSession(page));
  await awaitCancellable(run, client.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 85,
    maxWidth: VIEWPORT.width,
    maxHeight: VIEWPORT.height,
    everyNthFrame: 1,
  }));
  client.on('Page.screencastFrame', async ({ data, sessionId, metadata }) => {
    send('frame', {
      data,
      viewportWidth: metadata?.deviceWidth || VIEWPORT.width,
      viewportHeight: metadata?.deviceHeight || VIEWPORT.height,
    });
    try {
      await client.send('Page.screencastFrameAck', { sessionId });
    } catch {
      // WS/browser may already be closing; safe to ignore.
    }
  });
  return client;
}

async function stopScreencast(client) {
  if (!client) return;
  try {
    await client.send('Page.stopScreencast');
  } catch {}
  try {
    await client.detach();
  } catch {}
}

module.exports = {
  VIEWPORT,
  RunCancelledError,
  getActiveRun,
  getActiveJob,
  getActivePage,
  setActivePage,
  clearActivePage,
  clearActiveRun,
  cancelActiveRun,
  awaitCancellable,
  dispatchInput,
  createRunContext,
  setupScreencast,
  stopScreencast,
};
