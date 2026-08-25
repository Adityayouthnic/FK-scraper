const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { runScrapeJob, dispatchInput } = require('./src/scraper');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

let isRunning = false;
// The single WS connection allowed to send input (mouse/keyboard) into the
// live view: whichever connection's token-verified 'run' message started
// the current job. Prevents another tab/visitor from hijacking control
// mid-run even if they're connected to the same server.
let activeWs = null;

wss.on('connection', (ws) => {
  const send = (type, payload = {}) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type, ...payload }));
    }
  };

  send('log', { message: 'Connected. Click Run to start.' });
  send('status', { state: isRunning ? 'running' : 'idle' });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'input') {
      if (ws === activeWs) {
        dispatchInput(msg);
      }
      return;
    }

    if (msg.type !== 'run') return;

    const requiredToken = process.env.ACCESS_TOKEN;
    if (requiredToken && msg.token !== requiredToken) {
      send('error', { message: 'Invalid access code.' });
      return;
    }

    if (isRunning) {
      send('error', { message: 'A run is already in progress.' });
      return;
    }

    isRunning = true;
    activeWs = ws;
    send('status', { state: 'running' });

    try {
      const result = await runScrapeJob(send);
      send('done', { success: true, ...result });
    } catch (err) {
      console.error(err);
      send('error', { message: err.message || 'Run failed.' });
    } finally {
      isRunning = false;
      activeWs = null;
      send('status', { state: 'idle' });
    }
  });
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(`FK-scraper listening on :${port}`);
});
