const runBtn = document.getElementById('run-btn');
const statusText = document.getElementById('status-text');
const statusPill = document.getElementById('status-pill');
const liveView = document.getElementById('live-view');
const viewPlaceholder = document.getElementById('view-placeholder');
const liveBadge = document.getElementById('live-badge');
const log = document.getElementById('log');
const statStatus = document.getElementById('stat-status');
const statLastRun = document.getElementById('stat-last-run');
const statLastResult = document.getElementById('stat-last-result');
const runBtnLabel = runBtn.querySelector('span');

// Must match VIEWPORT in src/scraper.js.
const VIEWPORT_WIDTH = 1024;
const VIEWPORT_HEIGHT = 768;

let isRunning = false;
let lastMoveSent = 0;

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
  if (lower.startsWith('error')) return 'error';
  if (lower.includes('detected') || lower.includes('complete')) return 'done';
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
    liveView.style.display = 'none';
    viewPlaceholder.style.display = 'flex';
  }
}

ws.addEventListener('open', () => appendLog('Connected to server.'));
ws.addEventListener('close', () => appendLog('Disconnected from server.', 'error'));

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case 'log':
      appendLog(msg.message, classifyLog(msg.message));
      break;
    case 'frame':
      viewPlaceholder.style.display = 'none';
      liveView.style.display = 'block';
      liveView.src = `data:image/jpeg;base64,${msg.data}`;
      break;
    case 'status':
      setStatus(msg.state);
      break;
    case 'done':
      appendLog(`Done. ${msg.datesProcessed || 0} date(s) processed, ${msg.rowsAdded} row(s) added.`, 'done');
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
  ws.send(JSON.stringify({ type: 'run', token }));
});

// --- Relay mouse/keyboard into the remote browser via the live view ---
// so you can solve a captcha or click Login when the run pauses for it.

function sendInput(payload) {
  if (!isRunning || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'input', ...payload }));
}

function toViewportCoords(e) {
  const rect = liveView.getBoundingClientRect();
  return {
    x: Math.round(((e.clientX - rect.left) / rect.width) * VIEWPORT_WIDTH),
    y: Math.round(((e.clientY - rect.top) / rect.height) * VIEWPORT_HEIGHT),
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
  sendInput({ event: 'mousedown', ...toViewportCoords(e), button: buttonName(e) });
});

liveView.addEventListener('mouseup', (e) => {
  e.preventDefault();
  sendInput({ event: 'mouseup', ...toViewportCoords(e), button: buttonName(e) });
});

liveView.addEventListener('mousemove', (e) => {
  const now = Date.now();
  if (now - lastMoveSent < 25) return;
  lastMoveSent = now;
  sendInput({ event: 'mousemove', ...toViewportCoords(e) });
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
