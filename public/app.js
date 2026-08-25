const runBtn = document.getElementById('run-btn');
const statusText = document.getElementById('status-text');
const liveView = document.getElementById('live-view');
const viewPlaceholder = document.getElementById('view-placeholder');
const log = document.getElementById('log');

const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${proto}://${location.host}/ws`);

function appendLog(message) {
  const time = new Date().toLocaleTimeString();
  log.textContent += `[${time}] ${message}\n`;
  log.scrollTop = log.scrollHeight;
}

function getToken() {
  let token = localStorage.getItem('fk_scraper_token');
  if (!token) {
    token = prompt('Enter access code:') || '';
    localStorage.setItem('fk_scraper_token', token);
  }
  return token;
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
      statusText.textContent = msg.state === 'running' ? 'Running...' : 'Idle';
      runBtn.disabled = msg.state === 'running';
      if (msg.state === 'idle') {
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
        localStorage.removeItem('fk_scraper_token');
      }
      break;
  }
});

runBtn.addEventListener('click', () => {
  log.textContent = '';
  ws.send(JSON.stringify({ type: 'run', token: getToken() }));
});
