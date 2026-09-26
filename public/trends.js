const runBtn = document.getElementById('run-btn');
const statusText = document.getElementById('status-text');
const statusPill = document.getElementById('status-pill');
const liveView = document.getElementById('live-view');
const viewPlaceholder = document.getElementById('view-placeholder');
const liveBadge = document.getElementById('live-badge');
const log = document.getElementById('log');
const statStatus = document.getElementById('stat-status');
const statLastRun = document.getElementById('stat-last-run');
const statRowsAdded = document.getElementById('stat-rows-added');
const statLastResult = document.getElementById('stat-last-result');
const verticalSelect = document.getElementById('vertical-select');
const pagesInput = document.getElementById('pages-input');
const runBtnLabel = runBtn.querySelector('span');

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
  line.innerHTML = `<span class="ts">${time}</span> <span class="tag">[${tag}]</span> `;
  line.append(message);
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function classifyLog(message) {
  const lower = message.toLowerCase();
  if (lower.startsWith('error') || lower.includes('failed') || lower.includes('critical')) return 'error';
  if (lower.includes('detected') || lower.includes('complete') || lower.includes('done') || lower.includes('pushed')) return 'done';
  return 'info';
}

const STATUS_LABELS = { idle: 'Idle', running: 'Running...', done: 'Done', error: 'Error' };

function setStatus(state) {
  isRunning = state === 'running';
  statusPill.className = `status-pill status-${state}`;
  const label = STATUS_LABELS[state] || state;
  statusText.textContent = label;
  statStatus.textContent = label;
  runBtn.disabled = false;
  runBtnLabel.textContent = isRunning ? 'Stop Scraper' : 'Run Scraper';
  runBtn.classList.toggle('run-btn-stop', isRunning);
  liveBadge.classList.toggle('active', isRunning);
  if (!isRunning) {
    if (!liveView.src) {
      liveView.style.display = 'none';
      viewPlaceholder.style.display = 'flex';
    }
    verticalSelect.disabled = false;
    pagesInput.disabled = false;
  } else {
    verticalSelect.disabled = true;
    pagesInput.disabled = true;
  }
}

ws.addEventListener('open', () => appendLog('Connected to server. Ready to scrape Search Trends.'));
ws.addEventListener('close', () => appendLog('Disconnected from server.', 'error'));

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
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
      appendLog(`Done. ${msg.verticalsProcessed || 1} vertical(s) processed, ${msg.rowsAdded || 0} row(s) added to Google Sheets.`, 'done');
      statLastRun.textContent = new Date().toLocaleTimeString();
      statLastResult.textContent = 'Success';
      statRowsAdded.textContent = msg.rowsAdded || 0;
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
  const selectedVertical = verticalSelect.value;
  const pages = parseInt(pagesInput.value, 10) || 10;
  ws.send(JSON.stringify({
    type: 'run',
    job: 'trends',
    options: {
      vertical: selectedVertical,
      pages,
    },
    token,
  }));
});

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
  // Don't intercept typing when the user is editing the pages input or select
  if (document.activeElement === pagesInput || document.activeElement === verticalSelect) return;
  e.preventDefault();
  sendInput({ event: 'keydown', key: e.key });
});

window.addEventListener('keyup', (e) => {
  if (!isRunning) return;
  if (document.activeElement === pagesInput || document.activeElement === verticalSelect) return;
  e.preventDefault();
  sendInput({ event: 'keyup', key: e.key });
});
