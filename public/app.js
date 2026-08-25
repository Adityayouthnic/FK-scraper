const runBtn = document.getElementById('run-btn');
const statusText = document.getElementById('status-text');
const liveView = document.getElementById('live-view');
const viewPlaceholder = document.getElementById('view-placeholder');
const log = document.getElementById('log');

// Must match VIEWPORT in src/scraper.js.
const VIEWPORT_WIDTH = 1024;
const VIEWPORT_HEIGHT = 768;

let isRunning = false;
let lastMoveSent = 0;

const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${proto}://${location.host}/ws`);

function appendLog(message) {
  const time = new Date().toLocaleTimeString();
  log.textContent += `[${time}] ${message}\n`;
  log.scrollTop = log.scrollHeight;
}

ws.addEventListener('open', () => appendLog('Connected to server.'));
ws.addEventListener('close', () => appendLog('Disconnected from server.'));

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case 'log':
      appendLog(msg.message);
      break;
    case 'frame':
      viewPlaceholder.style.display = 'none';
      liveView.style.display = 'block';
      liveView.src = `data:image/jpeg;base64,${msg.data}`;
      break;
    case 'status':
      isRunning = msg.state === 'running';
      statusText.textContent = isRunning ? 'Running...' : 'Idle';
      runBtn.disabled = isRunning;
      if (!isRunning) {
        liveView.style.display = 'none';
        viewPlaceholder.style.display = 'block';
      }
      break;
    case 'done':
      appendLog(`Done. Rows added: ${msg.rowsAdded}`);
      break;
    case 'error':
      appendLog(`Error: ${msg.message}`);
      if (msg.message === 'Invalid access code.') {
        const token = prompt('Enter access code:') || '';
        localStorage.setItem('fk_scraper_token', token);
        appendLog('Access code saved. Click Run again.');
      }
      break;
  }
});

runBtn.addEventListener('click', () => {
  log.textContent = '';
  const token = localStorage.getItem('fk_scraper_token') || '';
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
