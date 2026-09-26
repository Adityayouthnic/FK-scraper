/**
 * Authentication and User Management Module
 *
 * Provides:
 *  - Password hashing via crypto.scryptSync (with random salt & timing-safe equality)
 *  - In-memory session tracking with cryptographic session tokens
 *  - Persistent user storage in data/users.json with automatic default admin seeding
 *  - Brute-force rate limiting by IP
 *  - Express authentication middleware (requireAuth, requireAdmin)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USERS_FILE = path.join(__dirname, '..', 'data', 'users.json');
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 5 * 60 * 1000; // 5 minutes

// In-memory active sessions: token -> { user, expiresAt, createdAt }
const activeSessions = new Map();

// Rate limiting: ip -> { count, firstAttempt, lockedUntil }
const loginAttempts = new Map();

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, storedHash, storedSalt) {
  if (!password || !storedHash || !storedSalt) return false;
  try {
    const hash = crypto.scryptSync(password, storedSalt, 64).toString('hex');
    const hashBuf = Buffer.from(hash, 'hex');
    const storedBuf = Buffer.from(storedHash, 'hex');
    if (hashBuf.length !== storedBuf.length) return false;
    return crypto.timingSafeEqual(hashBuf, storedBuf);
  } catch {
    return false;
  }
}

/**
 * Load or initialize users from data/users.json.
 */
function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      if (Array.isArray(data) && data.length > 0) return data;
    }
  } catch (err) {
    console.error('[auth] Failed to read users.json:', err.message);
  }

  // Seed default admin
  const defaultUsername = process.env.ADMIN_USERNAME || 'admin';
  const defaultPassword = process.env.ADMIN_PASSWORD || process.env.ACCESS_TOKEN || 'Admin@FK2026';
  const { salt, hash } = hashPassword(defaultPassword);

  const defaultAdmin = {
    username: defaultUsername,
    name: 'Administrator',
    role: 'admin',
    salt,
    hash,
    createdAt: new Date().toISOString(),
    lastLogin: null,
  };

  saveUsers([defaultAdmin]);
  console.log(`[auth] Default admin account seeded: username='${defaultUsername}'`);
  return [defaultAdmin];
}

function saveUsers(users) {
  try {
    const dir = path.dirname(USERS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
  } catch (err) {
    console.error('[auth] Failed to save users.json:', err.message);
  }
}

let usersCache = loadUsers();

/**
 * Check if an IP is temporarily locked out.
 */
function checkRateLimit(ip) {
  const record = loginAttempts.get(ip);
  if (!record) return { allowed: true };

  const now = Date.now();
  if (record.lockedUntil && record.lockedUntil > now) {
    const remainingSec = Math.ceil((record.lockedUntil - now) / 1000);
    return {
      allowed: false,
      message: `Too many failed login attempts. Please try again in ${remainingSec} seconds.`,
    };
  }

  // Reset window after 60s
  if (now - record.firstAttempt > 60 * 1000) {
    loginAttempts.delete(ip);
    return { allowed: true };
  }

  return { allowed: true };
}

function recordLoginAttempt(ip, success) {
  const now = Date.now();
  if (success) {
    loginAttempts.delete(ip);
    return;
  }

  const record = loginAttempts.get(ip) || { count: 0, firstAttempt: now, lockedUntil: null };
  record.count += 1;

  if (record.count >= MAX_LOGIN_ATTEMPTS) {
    record.lockedUntil = now + LOCKOUT_DURATION_MS;
    console.warn(`[auth] IP ${ip} locked out for 5 minutes after ${record.count} failed attempts.`);
  }

  loginAttempts.set(ip, record);
}

/**
 * Authenticate credentials.
 */
function authenticate(username, password, ip = 'unknown') {
  const rateLimit = checkRateLimit(ip);
  if (!rateLimit.allowed) {
    return { success: false, error: rateLimit.message, rateLimited: true };
  }

  const normalized = String(username || '').trim().toLowerCase();
  const user = usersCache.find((u) => u.username.toLowerCase() === normalized);

  if (!user || !verifyPassword(password, user.hash, user.salt)) {
    recordLoginAttempt(ip, false);
    return { success: false, error: 'Invalid username or password.' };
  }

  recordLoginAttempt(ip, true);

  // Update last login
  user.lastLogin = new Date().toISOString();
  saveUsers(usersCache);

  // Create session
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const sessionData = {
    user: {
      username: user.username,
      name: user.name || user.username,
      role: user.role || 'operator',
    },
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_DURATION_MS,
  };

  activeSessions.set(sessionToken, sessionData);
  return { success: true, token: sessionToken, user: sessionData.user };
}

/**
 * Validate a session token.
 */
function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const session = activeSessions.get(token);
  if (!session) return null;

  if (Date.now() > session.expiresAt) {
    activeSessions.delete(token);
    return null;
  }

  return session.user;
}

/**
 * Terminate a session.
 */
function destroySession(token) {
  if (token) activeSessions.delete(token);
}

/**
 * List all users without sensitive hash/salt fields.
 */
function listUsers() {
  return usersCache.map((u) => ({
    username: u.username,
    name: u.name,
    role: u.role,
    createdAt: u.createdAt,
    lastLogin: u.lastLogin,
  }));
}

/**
 * Create a new user.
 */
function createUser({ username, name, role = 'operator', password }) {
  if (!username || !password) {
    throw new Error('Username and password are required.');
  }

  const normalized = String(username).trim().toLowerCase();
  if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(normalized)) {
    throw new Error('Username must be 3-30 characters (letters, numbers, underscore, hyphen).');
  }

  if (usersCache.some((u) => u.username.toLowerCase() === normalized)) {
    throw new Error(`User '${username}' already exists.`);
  }

  if (password.length < 6) {
    throw new Error('Password must be at least 6 characters long.');
  }

  const { salt, hash } = hashPassword(password);
  const newUser = {
    username: normalized,
    name: name ? String(name).trim() : normalized,
    role: role === 'admin' ? 'admin' : 'operator',
    salt,
    hash,
    createdAt: new Date().toISOString(),
    lastLogin: null,
  };

  usersCache.push(newUser);
  saveUsers(usersCache);
  return { username: newUser.username, name: newUser.name, role: newUser.role };
}

/**
 * Update an existing user.
 */
function updateUser(username, { name, role, password }) {
  const normalized = String(username).trim().toLowerCase();
  const user = usersCache.find((u) => u.username.toLowerCase() === normalized);
  if (!user) throw new Error(`User '${username}' not found.`);

  if (name !== undefined) user.name = String(name).trim();
  if (role !== undefined) {
    // Ensure at least one admin remains
    if (user.role === 'admin' && role !== 'admin') {
      const adminCount = usersCache.filter((u) => u.role === 'admin').length;
      if (adminCount <= 1) throw new Error('Cannot demote the only remaining administrator.');
    }
    user.role = role === 'admin' ? 'admin' : 'operator';
  }

  if (password) {
    if (password.length < 6) throw new Error('Password must be at least 6 characters long.');
    const { salt, hash } = hashPassword(password);
    user.salt = salt;
    user.hash = hash;
  }

  saveUsers(usersCache);
  return { username: user.username, name: user.name, role: user.role };
}

/**
 * Delete a user.
 */
function deleteUser(username, requestingUsername) {
  const normalized = String(username).trim().toLowerCase();
  if (requestingUsername && normalized === requestingUsername.toLowerCase()) {
    throw new Error('You cannot delete your own account.');
  }

  const userIndex = usersCache.findIndex((u) => u.username.toLowerCase() === normalized);
  if (userIndex === -1) throw new Error(`User '${username}' not found.`);

  const user = usersCache[userIndex];
  if (user.role === 'admin') {
    const adminCount = usersCache.filter((u) => u.role === 'admin').length;
    if (adminCount <= 1) throw new Error('Cannot delete the only remaining administrator.');
  }

  usersCache.splice(userIndex, 1);
  saveUsers(usersCache);
  return true;
}

/**
 * Express Middleware to require authentication.
 */
function requireAuth(req, res, next) {
  const token = req.cookies?.fk_session || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);

  if (token) {
    const user = verifySession(token);
    if (user) {
      req.user = user;
      return next();
    }
  }

  // Check programmatic ACCESS_TOKEN fallback
  const apiToken = process.env.ACCESS_TOKEN;
  if (apiToken && token) {
    try {
      const aBuf = Buffer.from(token);
      const bBuf = Buffer.from(apiToken);
      if (aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf)) {
        req.user = { username: 'api_client', role: 'admin', name: 'API Client' };
        return next();
      }
    } catch {}
  }

  // Not authenticated
  const isApi = req.path.startsWith('/api/') || req.headers.accept?.includes('application/json');
  if (isApi) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const redirectUrl = encodeURIComponent(req.originalUrl || '/');
  return res.redirect(`/login?redirect=${redirectUrl}`);
}

/**
 * Express Middleware to require admin privileges.
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator privileges required.' });
  }
  next();
}

module.exports = {
  authenticate,
  verifySession,
  destroySession,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  requireAuth,
  requireAdmin,
  SESSION_DURATION_MS,
};
