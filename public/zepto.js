/**
 * Zepto Automation Dashboard Client Logic
 */

const runBtn = document.getElementById('run-btn');
const statusText = document.getElementById('status-text');
const statusPill = document.getElementById('status-pill');
const statusDot = document.getElementById('status-dot');
const liveView = document.getElementById('live-view');
const viewPlaceholder = document.getElementById('view-placeholder');
const liveBadge = document.getElementById('live-badge');
const liveSourceHint = document.getElementById('live-source-hint');
const log = document.getElementById('log');
const logContainer = document.getElementById('log-container');
const statStatus = document.getElementById('stat-status');
const statLastRun = document.getElementById('stat-last-run');
const statLastResult = document.getElementById('stat-last-result');
const clearLogBtn = document.getElementById('clear-log-btn');
const optHeaded = document.getElementById('opt-headed');
const runBtnLabel = runBtn.querySelector('span');

let currentAction = 'daily';
let isRunning = false;

// Action tab switching
const tabButtons = document.querySelectorAll('.tab-btn');
const panels = {
  daily: document.getElementById('panel-daily'),
  sales: document.getElementById('panel-sales'),
  inventory: document.getElementById('panel-inventory'),
  download: document.getElementById('panel-download'),
  login: document.getElementById('panel-login'),
};

const ACTION_BTN_LABELS = {
  daily: 'Run Daily Sync',
  sales: 'Run Sales Sync',
  inventory: 'Refresh FC Inventory',
  download: 'Download Report',
  login: 'Run Login Check',
};

tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (isRunning) return;
    const action = btn.getAttribute('data-action');
    currentAction = action;

    tabButtons.forEach((b) => {
      b.className = 'tab-btn px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-600 hover:text-slate-900 transition-all';
    });
    btn.className = 'tab-btn px-3 py-1.5 rounded-lg text-xs font-semibold bg-white text-fuchsia-700 shadow-sm transition-all';

    Object.keys(panels).forEach((k) => {
      if (panels[k]) {
        if (k === action) {
          panels[k].classList.remove('hidden');
        } else {
          panels[k].classList.add('hidden');
        }
      }
    });

    if (!isRunning) {
      runBtnLabel.textContent = ACTION_BTN_LABELS[action] || 'Run Automation';
    }
  });
});

// WebSocket Connection
const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${proto}://${location.host}/ws`);

const LOG_TAGS = { info: 'INFO', done: 'DONE', error: 'ERR', warn: 'WARN' };

function appendLog(message, kind) {
  const time = new Date().toLocaleTimeString();
  const cls = kind || 'info';
  const tag = LOG_TAGS[cls] || 'INFO';
  const line = document.createElement('div');
  line.className = `log-line ${cls}`;
  line.innerHTML = `<span class="ts text-slate-500 mr-2">${time}</span><span class="tag font-bold mr-2 text-[10px] uppercase">[${tag}]</span>`;
  line.append(` ${message}`);
  log.appendChild(line);
  if (logContainer) logContainer.scrollTop = logContainer.scrollHeight;
}

function classifyLog(message) {
  const lower = message.toLowerCase();
  if (lower.startsWith('error') || lower.includes('failed') || lower.includes('rejected') || lower.includes('critical')) return 'error';
  if (lower.startsWith('warning') || lower.includes('warning:')) return 'warn';
  if (lower.includes('completed') || lower.includes('done') || lower.includes('success') || lower.includes('ok — finished')) return 'done';
  return 'info';
}

function setStatus(state) {
  isRunning = state === 'running';
  statusText.textContent = state === 'running' ? 'Running...' : (state === 'done' ? 'Done' : (state === 'error' ? 'Error' : 'Idle'));
  statStatus.textContent = statusText.textContent;
  runBtn.disabled = false;

  tabButtons.forEach((b) => {
    b.disabled = isRunning;
    if (isRunning) b.classList.add('opacity-50', 'cursor-not-allowed');
    else b.classList.remove('opacity-50', 'cursor-not-allowed');
  });

  const svg = runBtn.querySelector('svg');
  if (isRunning) {
    runBtnLabel.textContent = 'Stop Process';
    runBtn.className = 'inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 active:scale-[0.98] text-white text-xs font-bold uppercase tracking-wider shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-rose-500 focus:ring-offset-2';
    if (svg) svg.innerHTML = '<use href="#icon-stop"/>';

    statusPill.className = 'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200';
    if (statusDot) statusDot.className = 'w-2 h-2 rounded-full bg-amber-500 animate-pulse';

    liveBadge.className = 'inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-rose-600';
    liveBadge.innerHTML = '<span class="relative flex h-2 w-2"><span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span><span class="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span></span><span>ACTIVE</span>';
  } else {
    runBtnLabel.textContent = ACTION_BTN_LABELS[currentAction] || 'Run Automation';
    runBtn.className = 'inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-fuchsia-600 hover:bg-fuchsia-700 active:scale-[0.98] text-white text-xs font-bold uppercase tracking-wider shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-fuchsia-500 focus:ring-offset-2';
    if (svg) svg.innerHTML = '<use href="#icon-play"/>';

    if (state === 'done') {
      statusPill.className = 'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200';
      if (statusDot) statusDot.className = 'w-2 h-2 rounded-full bg-emerald-500';
    } else if (state === 'error') {
      statusPill.className = 'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200';
      if (statusDot) statusDot.className = 'w-2 h-2 rounded-full bg-rose-500';
    } else {
      statusPill.className = 'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-600 border border-slate-200';
      if (statusDot) statusDot.className = 'w-2 h-2 rounded-full bg-slate-400';
    }

    liveBadge.className = 'inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-400';
    liveBadge.innerHTML = '<span class="relative flex h-2 w-2"><span class="relative inline-flex rounded-full h-2 w-2 bg-slate-400"></span></span><span>Standby</span>';
  }
}

ws.addEventListener('open', () => appendLog('Connected to server WebSocket. Zepto engine ready.'));
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
      if (viewPlaceholder) viewPlaceholder.style.display = 'none';
      liveView.style.display = 'block';
      liveView.src = `data:image/jpeg;base64,${msg.data}`;
      if (msg.source && liveSourceHint) {
        liveSourceHint.textContent = `Snapshot: ${msg.source}`;
      }
      break;
    case 'status':
      setStatus(msg.state);
      break;
    case 'done':
      appendLog(`Done. ${msg.message || 'Zepto automation run completed.'}`, 'done');
      statLastRun.textContent = new Date().toLocaleTimeString();
      statLastResult.textContent = 'Success';
      break;
    case 'cancelled':
      appendLog(msg.message || 'Run cancelled by user.', 'info');
      statLastRun.textContent = new Date().toLocaleTimeString();
      statLastResult.textContent = 'Cancelled';
      break;
    case 'error':
      appendLog(`Error: ${msg.message}`, 'error');
      statLastRun.textContent = new Date().toLocaleTimeString();
      statLastResult.textContent = 'Failed';
      break;
  }
});

runBtn.addEventListener('click', () => {
  if (isRunning) {
    ws.send(JSON.stringify({ type: 'cancel' }));
    appendLog('Cancellation requested.', 'info');
    return;
  }

  log.textContent = '';
  const options = {
    action: currentAction,
    headed: optHeaded ? optHeaded.checked : false,
  };

  if (currentAction === 'sales') {
    const days = document.getElementById('sales-days')?.value;
    const from = document.getElementById('sales-from')?.value?.trim();
    const to = document.getElementById('sales-to')?.value?.trim();
    const dryRun = document.getElementById('sales-dryrun')?.checked;
    if (days) options.days = parseInt(days, 10);
    if (from) options.from = from;
    if (to) options.to = to;
    if (dryRun) options.dryRun = true;
  } else if (currentAction === 'inventory') {
    const date = document.getElementById('inv-date')?.value?.trim();
    const dryRun = document.getElementById('inv-dryrun')?.checked;
    if (date) options.date = date;
    if (dryRun) options.dryRun = true;
  } else if (currentAction === 'download') {
    options.reportType = document.getElementById('report-type')?.value;
    const from = document.getElementById('rep-from')?.value?.trim();
    const to = document.getElementById('rep-to')?.value?.trim();
    const force = document.getElementById('rep-force')?.checked;
    if (from) options.from = from;
    if (to) options.to = to;
    if (force) options.force = true;
  } else if (currentAction === 'login') {
    const selectedMode = document.querySelector('input[name="login-mode"]:checked')?.value;
    options.mode = selectedMode || 'auto';
  }

  appendLog(`Launching Zepto automation [${currentAction}]...`);
  ws.send(JSON.stringify({
    type: 'run',
    job: 'zepto',
    options,
  }));
});

if (clearLogBtn) {
  clearLogBtn.addEventListener('click', () => {
    log.innerHTML = '';
  });
}

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

// Auth verification
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
      return;
    }
    const nameEl = document.getElementById('sidebar-user-name');
    if (nameEl) nameEl.textContent = data.user?.name || data.user?.username || 'Zepto Operator';
  } catch (err) {
    console.warn('Auth check error:', err);
  }
}
checkAuth();
