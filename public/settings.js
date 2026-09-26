/**
 * Settings & User Management Client Logic
 */

let currentUser = null;

function showToast(message, isError = false) {
  const toast = document.getElementById('toast-banner');
  const toastMsg = document.getElementById('toast-message');
  if (!toast || !toastMsg) return;

  toastMsg.textContent = message;
  toast.className = isError
    ? 'p-4 rounded-xl text-xs font-semibold flex items-center justify-between shadow-sm bg-rose-50 border border-rose-200 text-rose-800'
    : 'p-4 rounded-xl text-xs font-semibold flex items-center justify-between shadow-sm bg-emerald-50 border border-emerald-200 text-emerald-800';
  toast.classList.remove('hidden');

  setTimeout(() => {
    toast.classList.add('hidden');
  }, 4000);
}

async function loadProfile() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) {
      window.location.href = '/login?redirect=/settings';
      return;
    }
    const data = await res.json();
    if (!data.authenticated) {
      window.location.href = '/login?redirect=/settings';
      return;
    }

    currentUser = data.user;
    document.getElementById('current-user-name').textContent = currentUser.name || currentUser.username;
    document.getElementById('current-user-role').textContent = currentUser.role === 'admin' ? 'Administrator' : 'Operator';
    document.getElementById('user-avatar').textContent = (currentUser.name || currentUser.username).charAt(0).toUpperCase();

    // Disable administrative features if operator
    if (currentUser.role !== 'admin') {
      const adminElements = document.querySelectorAll('.admin-only');
      adminElements.forEach((el) => el.classList.add('hidden'));
    }
  } catch (err) {
    console.error('Failed to load profile:', err);
  }
}

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    if (res.status === 401 || res.status === 403) return;
    if (!res.ok) throw new Error('Failed to load settings');
    const creds = await res.json();

    document.getElementById('fk-email').value = creds.flipkartEmail || '';
    if (creds.hasFlipkartPassword) {
      document.getElementById('fk-cred-status').className = 'px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200';
      document.getElementById('fk-cred-status').textContent = 'Configured';
    } else {
      document.getElementById('fk-cred-status').className = 'px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200';
      document.getElementById('fk-cred-status').textContent = 'Password Missing';
    }

    document.getElementById('wallet-sheet-id').value = creds.spreadsheetId || '';
    document.getElementById('trends-sheet-id').value = creds.trendsSpreadsheetId || '';
    document.getElementById('alert-webhook-url').value = creds.alertWebhookUrl || '';
    document.getElementById('api-access-token').value = creds.apiAccessToken || '';
  } catch (err) {
    showToast(err.message, true);
  }
}

async function loadUsers() {
  try {
    const res = await fetch('/api/users');
    if (res.status === 401 || res.status === 403) return;
    if (!res.ok) throw new Error('Failed to load users');
    const users = await res.json();

    const tbody = document.getElementById('users-table-body');
    if (!users || users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="px-6 py-4 text-center text-slate-400">No users found.</td></tr>';
      return;
    }

    tbody.innerHTML = users.map((u) => {
      const isSelf = currentUser && currentUser.username.toLowerCase() === u.username.toLowerCase();
      const roleBadge = u.role === 'admin'
        ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-50 text-purple-700 border border-purple-200">ADMIN</span>'
        : '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-600 border border-slate-200">OPERATOR</span>';

      const createdStr = u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '&mdash;';
      const lastLoginStr = u.lastLogin ? new Date(u.lastLogin).toLocaleString() : 'Never';

      return `
        <tr class="hover:bg-slate-50/80 transition-colors">
          <td class="px-6 py-3.5 font-semibold text-slate-900">${escapeHtml(u.username)} ${isSelf ? '<span class="text-[10px] text-brand-600 font-medium">(You)</span>' : ''}</td>
          <td class="px-6 py-3.5 text-slate-600">${escapeHtml(u.name || '&mdash;')}</td>
          <td class="px-6 py-3.5">${roleBadge}</td>
          <td class="px-6 py-3.5 text-slate-500">${createdStr}</td>
          <td class="px-6 py-3.5 text-slate-500">${lastLoginStr}</td>
          <td class="px-6 py-3.5 text-right space-x-2">
            <button onclick="openPwdModal('${escapeHtml(u.username)}')" class="text-brand-600 hover:text-brand-800 font-medium">Change Password</button>
            ${!isSelf ? `<button onclick="deleteUserPrompt('${escapeHtml(u.username)}')" class="text-rose-600 hover:text-rose-800 font-medium ml-2">Delete</button>` : ''}
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to load users:', err);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Password toggle
const toggleFkPwdBtn = document.getElementById('toggle-fk-password');
if (toggleFkPwdBtn) {
  toggleFkPwdBtn.addEventListener('click', () => {
    const input = document.getElementById('fk-password');
    input.type = input.type === 'password' ? 'text' : 'password';
  });
}

// Save Flipkart credentials
const fkCredsForm = document.getElementById('fk-creds-form');
if (fkCredsForm) {
  fkCredsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('fk-email').value.trim();
    const password = document.getElementById('fk-password').value;

    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          flipkartEmail: email,
          flipkartPassword: password || undefined,
        }),
      });

      if (!res.ok) throw new Error('Failed to update Flipkart credentials.');
      showToast('Flipkart credentials updated successfully!');
      document.getElementById('fk-password').value = '';
      await loadSettings();
    } catch (err) {
      showToast(err.message, true);
    }
  });
}

// Save Sheets IDs
const sheetsForm = document.getElementById('sheets-config-form');
if (sheetsForm) {
  sheetsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const walletSheet = document.getElementById('wallet-sheet-id').value.trim();
    const trendsSheet = document.getElementById('trends-sheet-id').value.trim();

    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spreadsheetId: walletSheet,
          trendsSpreadsheetId: trendsSheet,
        }),
      });

      if (!res.ok) throw new Error('Failed to update Google Sheets settings.');
      showToast('Google Sheets IDs updated successfully!');
      await loadSettings();
    } catch (err) {
      showToast(err.message, true);
    }
  });
}

// Save Webhook
const saveWebhookBtn = document.getElementById('save-webhook-btn');
if (saveWebhookBtn) {
  saveWebhookBtn.addEventListener('click', async () => {
    const webhookUrl = document.getElementById('alert-webhook-url').value.trim();
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertWebhookUrl: webhookUrl }),
      });
      if (!res.ok) throw new Error('Failed to update Webhook URL.');
      showToast('Notification Webhook updated!');
      await loadSettings();
    } catch (err) {
      showToast(err.message, true);
    }
  });
}

// Test Webhook
const testWebhookBtn = document.getElementById('test-webhook-btn');
if (testWebhookBtn) {
  testWebhookBtn.addEventListener('click', async () => {
    const webhookUrl = document.getElementById('alert-webhook-url').value.trim();
    if (!webhookUrl) {
      showToast('Enter a Webhook URL first.', true);
      return;
    }
    testWebhookBtn.textContent = 'Sending...';
    try {
      const res = await fetch('/api/settings/test-webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhookUrl }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed to trigger test alert.');
      showToast('Test notification sent successfully!');
    } catch (err) {
      showToast(`Test alert failed: ${err.message}`, true);
    } finally {
      testWebhookBtn.textContent = 'Test Alert';
    }
  });
}

// Copy Token
const copyTokenBtn = document.getElementById('copy-token-btn');
if (copyTokenBtn) {
  copyTokenBtn.addEventListener('click', () => {
    const token = document.getElementById('api-access-token').value;
    if (!token) return;
    navigator.clipboard.writeText(token).then(() => {
      showToast('API Token copied to clipboard!');
    });
  });
}

// Regenerate Token
const regenerateTokenBtn = document.getElementById('regenerate-token-btn');
if (regenerateTokenBtn) {
  regenerateTokenBtn.addEventListener('click', async () => {
    if (!confirm('Regenerate API Access Token? Any external services using the previous token will need to be updated.')) return;
    const newToken = Array.from(crypto.getRandomValues(new Uint8Array(24)))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiAccessToken: newToken }),
      });
      if (!res.ok) throw new Error('Failed to regenerate token');
      showToast('New API Access Token generated!');
      await loadSettings();
    } catch (err) {
      showToast(err.message, true);
    }
  });
}

// Add User Modal
function openAddUserModal() {
  document.getElementById('add-user-modal').classList.remove('hidden');
  document.getElementById('add-user-modal').classList.add('flex');
}
function closeAddUserModal() {
  document.getElementById('add-user-modal').classList.add('hidden');
  document.getElementById('add-user-modal').classList.remove('flex');
}

const openAddUserBtn = document.getElementById('open-add-user-btn');
if (openAddUserBtn) openAddUserBtn.addEventListener('click', openAddUserModal);

const addUserForm = document.getElementById('add-user-form');
if (addUserForm) {
  addUserForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('new-username').value.trim();
    const name = document.getElementById('new-name').value.trim();
    const role = document.getElementById('new-role').value;
    const password = document.getElementById('new-password').value;

    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, name, role, password }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed to create user');
      showToast(`User '${username}' created successfully!`);
      closeAddUserModal();
      addUserForm.reset();
      await loadUsers();
    } catch (err) {
      showToast(err.message, true);
    }
  });
}

// Change Password Modal
function openPwdModal(username) {
  document.getElementById('pwd-target-user').value = username;
  document.getElementById('pwd-modal-user').textContent = username;
  document.getElementById('target-new-password').value = '';
  document.getElementById('change-pwd-modal').classList.remove('hidden');
  document.getElementById('change-pwd-modal').classList.add('flex');
}
function closePwdModal() {
  document.getElementById('change-pwd-modal').classList.add('hidden');
  document.getElementById('change-pwd-modal').classList.remove('flex');
}

const changePwdForm = document.getElementById('change-pwd-form');
if (changePwdForm) {
  changePwdForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('pwd-target-user').value;
    const password = document.getElementById('target-new-password').value;

    try {
      const res = await fetch(`/api/users/${encodeURIComponent(username)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed to update password');
      showToast(`Password updated for '${username}'!`);
      closePwdModal();
    } catch (err) {
      showToast(err.message, true);
    }
  });
}

// Delete User
async function deleteUserPrompt(username) {
  if (!confirm(`Are you sure you want to delete user '${username}'? This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/users/${encodeURIComponent(username)}`, {
      method: 'DELETE',
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Failed to delete user');
    showToast(`User '${username}' deleted.`);
    await loadUsers();
  } catch (err) {
    showToast(err.message, true);
  }
}

// Logout
const logoutBtn = document.getElementById('logout-btn');
if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    if (confirm('Sign out of the scraper dashboard?')) {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login';
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadProfile();
  await loadSettings();
  await loadUsers();
});
