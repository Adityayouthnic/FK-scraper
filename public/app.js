const runBtn = document.getElementById('run-btn');
const statusText = document.getElementById('status-text');
const statusPill = document.getElementById('status-pill');
const statusDot = document.getElementById('status-dot');
const liveView = document.getElementById('live-view');
const viewPlaceholder = document.getElementById('view-placeholder');
const liveBadge = document.getElementById('live-badge');
const log = document.getElementById('log');
const statStatus = document.getElementById('stat-status');
const statLastRun = document.getElementById('stat-last-run');
const statLastResult = document.getElementById('stat-last-result');
const clearLogBtn = document.getElementById('clear-log-btn');
const resetSessionBtn = document.getElementById('reset-session-btn');
const runBtnLabel = runBtn.querySelector('span');

// Must match VIEWPORT in src/scraper.js
const VIEWPORT_WIDTH = 1024;
const VIEWPORT_HEIGHT = 768;

let isRunning = false;
let lastMoveSent = 0;
let remoteViewport = { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT };

const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${proto}://${location.host}/ws`);

const LOG_TAGS = { info: 'INFO', done: 'DONE', error: 'ERR' };

function appendLog(message, kind) {
  const time = new Date().toLocaleTimeString();
  const cls = kind || 'info';
  const tag = LOG_TAGS[cls];
  const line = document.createElement('div');
  line.className = `log-line ${cls}`;
  line.innerHTML = `<span class="ts">${time}</span><span class="tag">[${tag}]</span>`;
  line.append(` ${message}`);
  log.appendChild(line);
  const container = log.parentElement;
  if (container) container.scrollTop = container.scrollHeight;
}

function classifyLog(message) {
  const lower = message.toLowerCase();
  if (lower.startsWith('error') || lower.includes('failed') || lower.includes('critical')) return 'error';
  if (lower.includes('detected') || lower.includes('complete') || lower.includes('done') || lower.includes('pushed') || lower.includes('succeeded')) return 'done';
  return 'info';
}

const STATUS_LABELS = { idle: 'Idle', running: 'Running...', done: 'Done', error: 'Error' };

function setStatus(state) {
  isRunning = state === 'running';
  const label = STATUS_LABELS[state] || state;
  statusText.textContent = label;
  statStatus.textContent = label;
  runBtn.disabled = false;
  runBtnLabel.textContent = isRunning ? 'Stop Scraper' : 'Run Scraper';

  // Status pill styling
  if (state === 'running') {
    statusPill.className = 'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200';
    if (statusDot) statusDot.className = 'w-2 h-2 rounded-full bg-amber-500 animate-pulse';
  } else if (state === 'done') {
    statusPill.className = 'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200';
    if (statusDot) statusDot.className = 'w-2 h-2 rounded-full bg-emerald-500';
  } else if (state === 'error') {
    statusPill.className = 'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200';
    if (statusDot) statusDot.className = 'w-2 h-2 rounded-full bg-rose-500';
  } else {
    statusPill.className = 'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-600 border border-slate-200';
    if (statusDot) statusDot.className = 'w-2 h-2 rounded-full bg-slate-400';
  }

  // Run button styling
  const svg = runBtn.querySelector('svg');
  if (isRunning) {
    runBtn.className = 'inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 active:scale-[0.98] text-white text-sm font-semibold shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-rose-500 focus:ring-offset-2';
    if (svg) svg.innerHTML = '<use href="#icon-stop"/>';
  } else {
    runBtn.className = 'inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 active:scale-[0.98] text-white text-sm font-semibold shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2';
    if (svg) svg.innerHTML = '<use href="#icon-play"/>';
  }

  // Live badge styling
  if (isRunning) {
    liveBadge.className = 'inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-rose-600';
    liveBadge.innerHTML = '<span class="relative flex h-2 w-2"><span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span><span class="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span></span><span>LIVE</span>';
  } else {
    liveBadge.className = 'inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-400';
    liveBadge.innerHTML = '<span class="relative flex h-2 w-2"><span class="relative inline-flex rounded-full h-2 w-2 bg-slate-400"></span></span><span>Standby</span>';
    liveView.style.display = 'none';
    viewPlaceholder.style.display = 'flex';
  }
}

ws.addEventListener('open', () => appendLog('Connected to FK-Scraper server. Ready to run.'));
ws.addEventListener('close', () => appendLog('Disconnected from server.', 'error'));

ws.addEventListener('message', (event) => {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    return;
  }

  switch (msg.type) {
    case 'log':
      appendLog(msg.message, classifyLog(msg.message));
      break;
    case 'frame':
      remoteViewport = {
        width: Number(msg.viewportWidth) || VIEWPORT_WIDTH,
        height: Number(msg.viewportHeight) || VIEWPORT_HEIGHT,
      };
      viewPlaceholder.style.display = 'none';
      liveView.style.display = 'block';
      liveView.src = `data:image/jpeg;base64,${msg.data}`;
      break;
    case 'status':
      setStatus(msg.state);
      break;
    case 'done':
      appendLog(`Done. ${msg.datesProcessed || 0} date(s) processed, ${msg.rowsAdded || 0} row(s) added to Google Sheets.`, 'done');
      statLastRun.textContent = new Date().toLocaleTimeString();
      statLastResult.textContent = 'Success';
      break;
    case 'cancelled':
      appendLog(msg.message || 'Run cancelled.', 'info');
      statLastRun.textContent = new Date().toLocaleTimeString();
      statLastResult.textContent = 'Cancelled';
      break;
    case 'error':
      appendLog(`Error: ${msg.message}`, 'error');
      statLastRun.textContent = new Date().toLocaleTimeString();
      statLastResult.textContent = 'Failed';
      if (msg.message === 'Invalid access code.') {
        const token = prompt('Enter access code:') || '';
        localStorage.setItem('fk_scraper_token', token);
        appendLog('Access code saved. Click Run again.');
      }
      break;
  }
});

runBtn.addEventListener('click', () => {
  const token = localStorage.getItem('fk_scraper_token') || '';
  if (isRunning) {
    ws.send(JSON.stringify({ type: 'cancel', token }));
    appendLog('Cancellation requested.', 'info');
    return;
  }
  log.textContent = '';
  ws.send(JSON.stringify({ type: 'run', job: 'wallet', token }));
});

if (clearLogBtn) {
  clearLogBtn.addEventListener('click', () => {
    log.innerHTML = '';
  });
}

if (resetSessionBtn) {
  resetSessionBtn.addEventListener('click', () => {
    if (confirm('Close and reset the live browser session? Next run will start a fresh browser.')) {
      ws.send(JSON.stringify({ type: 'reset_session' }));
      appendLog('Live browser reset requested.', 'info');
    }
  });
}

// --- Relay mouse/keyboard into the remote browser via the live view ---
function sendInput(payload) {
  if (!isRunning || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'input', ...payload }));
}

function toViewportCoords(e) {
  const rect = liveView.getBoundingClientRect();
  const scale = Math.min(
    rect.width / remoteViewport.width,
    rect.height / remoteViewport.height,
  );
  if (!Number.isFinite(scale) || scale <= 0) return null;

  const contentWidth = remoteViewport.width * scale;
  const contentHeight = remoteViewport.height * scale;
  const offsetX = (rect.width - contentWidth) / 2;
  const offsetY = (rect.height - contentHeight) / 2;
  const x = e.clientX - rect.left - offsetX;
  const y = e.clientY - rect.top - offsetY;
  if (x < 0 || y < 0 || x > contentWidth || y > contentHeight) return null;

  return {
    x: Math.max(0, Math.min(remoteViewport.width - 1, Math.round(x / scale))),
    y: Math.max(0, Math.min(remoteViewport.height - 1, Math.round(y / scale))),
  };
}

function buttonName(e) {
  return e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
}

liveView.draggable = false;
liveView.addEventListener('dragstart', (e) => e.preventDefault());
liveView.addEventListener('contextmenu', (e) => e.preventDefault());

liveView.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const point = toViewportCoords(e);
  if (point) sendInput({ event: 'mousedown', ...point, button: buttonName(e) });
});

liveView.addEventListener('mouseup', (e) => {
  e.preventDefault();
  const point = toViewportCoords(e);
  if (point) sendInput({ event: 'mouseup', ...point, button: buttonName(e) });
});

liveView.addEventListener('mousemove', (e) => {
  const now = Date.now();
  if (now - lastMoveSent < 25) return;
  lastMoveSent = now;
  const point = toViewportCoords(e);
  if (point) sendInput({ event: 'mousemove', ...point });
});

liveView.addEventListener('wheel', (e) => {
  e.preventDefault();
  sendInput({ event: 'wheel', deltaX: e.deltaX, deltaY: e.deltaY });
});

window.addEventListener('keydown', (e) => {
  if (!isRunning) return;
  e.preventDefault();
  sendInput({ event: 'keydown', key: e.key });
});

window.addEventListener('keyup', (e) => {
  if (!isRunning) return;
  e.preventDefault();
  sendInput({ event: 'keyup', key: e.key });
});

// Logout handler
const logoutBtn = document.getElementById('logout-btn');
if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    if (confirm('Sign out of the scraper dashboard?')) {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login';
    }
  });
}

// Ensure session is valid
async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) {
      window.location.href = '/login?redirect=' + encodeURIComponent(window.location.pathname);
      return;
    }
    const data = await res.json();
    if (!data.authenticated) {
      window.location.href = '/login?redirect=' + encodeURIComponent(window.location.pathname);
    }
  } catch (err) {
    console.warn('Auth check failed:', err);
  }
}
checkAuth();
