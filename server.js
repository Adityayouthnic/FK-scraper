require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const { runScrapeJob } = require('./src/scraper');
const { runTrendsJob } = require('./src/trendsScraper');
const { runZeptoJob, getZeptoSessionStatus } = require('./src/zeptoScraper');
const { dispatchInput, cancelActiveRun, getActiveRun } = require('./src/runner');
const { closeLiveSession } = require('./src/sessionManager');
const { initScheduler, getScheduleStatus, executeScheduledJob, updateScheduleConfig } = require('./src/scheduler');
const { sendAlert } = require('./src/alerts');
const {
  authenticate,
  verifySession,
  destroySession,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  requireAuth,
  requireAdmin,
  isAuthRequired,
  SESSION_DURATION_MS,
} = require('./src/auth');
const { getSafeCredentials, updateCredentials, getRawZeptoCredentials } = require('./src/credentials');
const { getUnmappedReport } = require('./src/unmappedStore');
const { testImapConnection } = require('./src/zeptoOtp');
const { testSmtpConnection } = require('./src/zeptoNotify');
const { getSheetsClient, getAuthIdentity } = require('./src/googleAuth');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(cookieParser());

// Security Headers & Defense-in-depth
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' wss: ws: https:; frame-ancestors 'self';"
  );
  next();
});

// Origin / CSRF Defense for mutating API endpoints
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (origin && host) {
      try {
        const originHost = new URL(origin).host;
        if (originHost !== host) {
          return res.status(403).json({ error: 'Cross-origin API request forbidden.' });
        }
      } catch {
        return res.status(403).json({ error: 'Malformed origin header.' });
      }
    }
  }
  next();
});

// --- Public Authentication Routes ---

app.get('/login', (req, res) => {
  if (!isAuthRequired()) {
    return res.redirect('/');
  }
  const token = req.cookies?.fk_session;
  if (token && verifySession(token)) {
    const rawRedirect = req.query.redirect || '/';
    const safeRedirect = (typeof rawRedirect === 'string' && rawRedirect.startsWith('/') && !rawRedirect.startsWith('//') && !rawRedirect.includes('\\'))
      ? rawRedirect
      : '/';
    return res.redirect(safeRedirect);
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  const result = authenticate(username, password, clientIp);

  if (!result.success) {
    const statusCode = result.rateLimited ? 429 : 401;
    return res.status(statusCode).json(result);
  }

  const isSecure = process.env.NODE_ENV === 'production' || req.secure || req.headers['x-forwarded-proto'] === 'https';

  res.cookie('fk_session', result.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecure,
    maxAge: SESSION_DURATION_MS,
    path: '/',
  });

  res.json({ success: true, user: result.user });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies?.fk_session;
  if (token) destroySession(token);
  const isSecure = process.env.NODE_ENV === 'production' || req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.clearCookie('fk_session', {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecure,
    path: '/',
  });
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!isAuthRequired()) {
    return res.json({
      authenticated: true,
      authRequired: false,
      user: { username: 'admin', name: 'Administrator', role: 'admin' },
    });
  }
  const token = req.cookies?.fk_session;
  const user = verifySession(token);
  if (!user) {
    return res.json({ authenticated: false, authRequired: true });
  }
  res.json({ authenticated: true, authRequired: true, user });
});

// --- Protected Dashboard Views ---

app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/trends', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'trends.html'));
});

app.get('/settings', requireAuth, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

// --- Protected Scheduling Endpoints ---

app.get('/api/schedule', requireAuth, (req, res) => {
  res.json(getScheduleStatus());
});

app.post('/api/schedule', requireAuth, requireAdmin, (req, res) => {
  try {
    const updated = updateScheduleConfig(req.body || {});
    res.json({ success: true, schedule: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Protected Settings & Credentials Endpoints ---

app.get('/api/settings', requireAuth, requireAdmin, (req, res) => {
  res.json(getSafeCredentials());
});

app.post('/api/settings', requireAuth, requireAdmin, (req, res) => {
  try {
    const updated = updateCredentials(req.body || {});
    res.json({ success: true, settings: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/settings/test-webhook', requireAuth, requireAdmin, async (req, res) => {
  const { webhookUrl } = req.body || {};
  if (!webhookUrl) return res.status(400).json({ error: 'Webhook URL is required.' });

  try {
    const result = await sendAlert(
      'Test Notification',
      'Webhook alerts are configured and functional from FK-Scraper!',
      {
        url: req.protocol + '://' + req.get('host'),
        time: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }),
      },
      webhookUrl
    );
    if (result && !result.success) {
      return res.status(400).json(result);
    }
    res.json(result || { success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Lookup Health & Diagnostics ---

app.get('/api/zepto/lookups/unmapped', requireAuth, (req, res) => {
  res.json(getUnmappedReport());
});

app.get('/api/health/lookups', requireAuth, (req, res) => {
  res.json(getUnmappedReport());
});

app.get('/api/zepto/session/status', requireAuth, (req, res) => {
  res.json(getZeptoSessionStatus());
});

app.post('/api/settings/test-connections', requireAuth, requireAdmin, async (req, res) => {
  const results = {
    sheets: { success: false },
    imap: { success: false },
    smtp: { success: false },
  };

  // 1. Test Google Sheets
  try {
    const creds = getRawZeptoCredentials();
    const sheetId = creds.sheetId || process.env.GSHEET_ID;
    if (!sheetId) {
      results.sheets = { success: false, error: 'GSHEET_ID is not configured.' };
    } else {
      const sheets = await getSheetsClient();
      const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
      const ident = getAuthIdentity();
      results.sheets = {
        success: true,
        title: meta.data.properties.title,
        authType: ident.type,
        identity: ident.identity,
        message: `Connected to '${meta.data.properties.title}' via ${ident.type} (${ident.identity}).`,
      };
    }
  } catch (err) {
    results.sheets = { success: false, error: err.message };
  }

  // 2. Test IMAP
  try {
    const creds = getRawZeptoCredentials();
    const imapRes = await testImapConnection({
      host: creds.imapHost,
      user: creds.imapUser,
      password: creds.imapPassword,
    });
    results.imap = imapRes;
  } catch (err) {
    results.imap = { success: false, error: err.message };
  }

  // 3. Test SMTP
  try {
    const smtpRes = await testSmtpConnection();
    results.smtp = smtpRes;
  } catch (err) {
    results.smtp = { success: false, error: err.message };
  }

  res.json(results);
});

// --- Protected User Management Endpoints ---

app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  res.json(listUsers());
});

app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
  try {
    const user = createUser(req.body || {});
    res.json({ success: true, user });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.put('/api/users/:username', requireAuth, (req, res) => {
  const targetUsername = req.params.username;
  const isSelf = req.user.username.toLowerCase() === targetUsername.toLowerCase();
  const isAdmin = req.user.role === 'admin';

  if (!isSelf && !isAdmin) {
    return res.status(403).json({ error: 'Unauthorized to modify other users.' });
  }

  const updates = { password: req.body.password };
  if (isAdmin) {
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.role !== undefined) updates.role = req.body.role;
  }

  try {
    const updated = updateUser(targetUsername, updates);
    res.json({ success: true, user: updated });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/users/:username', requireAuth, requireAdmin, (req, res) => {
  try {
    deleteUser(req.params.username, req.user.username);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// --- Programmatic Trigger Middleware (Session or Bearer ACCESS_TOKEN) ---

function verifyRunnerAuth(req, res, next) {
  if (!isAuthRequired()) {
    return next();
  }

  // 1. Session Cookie Auth
  const sessionToken = req.cookies?.fk_session;
  if (sessionToken && verifySession(sessionToken)) {
    return next();
  }

  // 2. Programmatic Bearer Token Auth
  const requiredToken = process.env.ACCESS_TOKEN;
  if (!requiredToken) {
    return res.status(401).json({ error: 'Unauthorized: Authentication required.' });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : req.query.token;

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: Access token or session required.' });
  }

  try {
    const a = Buffer.from(token);
    const b = Buffer.from(requiredToken);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return next();
    }
  } catch {}

  return res.status(401).json({ error: 'Unauthorized: Invalid access token.' });
}

app.post('/api/run/wallet', verifyRunnerAuth, async (req, res) => {
  if (isRunning) {
    return res.status(409).json({ error: 'A run is already in progress.' });
  }
  const result = await executeScheduledJob('wallet', req.body || {}, broadcast);
  res.json(result);
});

app.post('/api/run/trends', verifyRunnerAuth, async (req, res) => {
  if (isRunning) {
    return res.status(409).json({ error: 'A run is already in progress.' });
  }
  const result = await executeScheduledJob('trends', req.body || {}, broadcast);
  res.json(result);
});

app.post('/api/run/zepto', verifyRunnerAuth, async (req, res) => {
  if (isRunning) {
    return res.status(409).json({ error: 'A run is already in progress.' });
  }
  const result = await executeScheduledJob('zepto', req.body || {}, broadcast);
  res.json(result);
});

app.get('/zepto', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'zepto.html'));
});

// Prevent unauthenticated direct loading of sensitive HTML static files
app.use((req, res, next) => {
  if (req.path.endsWith('.html') && req.path !== '/login.html') {
    return requireAuth(req, res, next);
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

let isRunning = false;
let activeJob = null;
let activeWs = null;
const connectedClients = new Set();

function broadcast(type, payload = {}) {
  const message = JSON.stringify({ type, ...payload });
  for (const client of connectedClients) {
    if (client.readyState === client.OPEN) client.send(message);
  }
}

function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach((cookie) => {
    let [name, ...rest] = cookie.split('=');
    name = name?.trim();
    if (!name) return;
    const value = rest.join('=').trim();
    list[name] = decodeURIComponent(value);
  });
  return list;
}

wss.on('connection', (ws, req) => {
  // Authenticate WebSocket connection
  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies.fk_session;
  let authenticatedUser = verifySession(sessionToken);

  if (!isAuthRequired()) {
    authenticatedUser = authenticatedUser || { username: 'admin', role: 'admin' };
  }

  if (!authenticatedUser) {
    // Check URL query token e.g. /ws?token=...
    try {
      const url = new URL(req.url, 'http://localhost');
      const queryToken = url.searchParams.get('token');
      const apiToken = process.env.ACCESS_TOKEN;
      if (apiToken && queryToken) {
        const a = Buffer.from(queryToken);
        const b = Buffer.from(apiToken);
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
          authenticatedUser = { username: 'api_client', role: 'admin' };
        }
      }
    } catch {}
  }

  if (!authenticatedUser) {
    console.warn(`[ws] Unauthenticated connection rejected from ${req.socket.remoteAddress}`);
    ws.send(JSON.stringify({ type: 'error', message: 'Authentication required. Please sign in.' }));
    ws.close(4001, 'Unauthorized');
    return;
  }

  connectedClients.add(ws);
  const send = (type, payload = {}) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type, ...payload }));
    }
  };

  send('log', { message: `Connected as ${authenticatedUser.username}. Click Run to start.` });
  send('status', { state: isRunning ? 'running' : 'idle', job: activeJob });

  ws.on('close', () => {
    connectedClients.delete(ws);
    if (ws === activeWs) activeWs = null;
  });

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

    if (msg.type === 'cancel') {
      if (!isRunning) {
        send('log', { message: 'No run is currently in progress.' });
        send('status', { state: 'idle' });
        return;
      }
      send('log', { message: 'Stopping process immediately...' });
      cancelActiveRun();
      setTimeout(() => {
        if (isRunning) {
          isRunning = false;
          activeWs = null;
          activeJob = null;
          broadcast('status', { state: 'idle' });
          broadcast('cancelled', { message: 'Process stopped by user.' });
        }
      }, 500);
      return;
    }

    if (msg.type === 'reset_session') {
      send('log', { message: 'Closing live browser session...' });
      await closeLiveSession();
      send('log', { message: 'Live browser session closed. Next run will start fresh.' });
      return;
    }

    if (msg.type !== 'run') return;

    if (isRunning) {
      send('error', { message: 'A run is already in progress.' });
      return;
    }

    isRunning = true;
    activeWs = ws;
    activeJob = msg.job || 'wallet';
    broadcast('status', { state: 'running', job: activeJob });

    try {
      let result;
      if (activeJob === 'trends') {
        result = await runTrendsJob(send, msg.options || {});
      } else if (activeJob === 'zepto') {
        result = await runZeptoJob(send, msg.options || {});
      } else {
        result = await runScrapeJob(send);
      }
      send('done', { success: true, job: activeJob, ...result });
    } catch (err) {
      const activeRun = getActiveRun();
      if (err.code === 'RUN_CANCELLED' || err.name === 'RunCancelledError' || (activeRun && activeRun.cancelled)) {
        broadcast('cancelled', { message: 'Process stopped by user.', job: activeJob });
      } else {
        console.error(err);
        send('error', { message: err.message || 'Run failed.', job: activeJob });
      }
    } finally {
      isRunning = false;
      activeWs = null;
      activeJob = null;
      broadcast('status', { state: 'idle' });
    }
  });
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(`FK-scraper listening on :${port}`);
  initScheduler(broadcast, () => isRunning, (val, job) => {
    isRunning = val;
    activeJob = job;
  });
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing live browser session...');
  await closeLiveSession();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, closing live browser session...');
  await closeLiveSession();
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught Exception:', err);
});

