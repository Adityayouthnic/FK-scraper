/**
 * Unified Schedule Modal & Status Manager
 * Handles fetching, displaying, and updating auto-run schedules for:
 *   - Flipkart Ads Wallet (Daily)
 *   - Flipkart Search Trends (Weekly Mondays)
 *   - Zepto Daily Sales & Inventory Sync (Daily)
 */

(function () {
  function cronToTime(cronStr, defaultTime = '07:00') {
    if (!cronStr) return defaultTime;
    const parts = cronStr.trim().split(/\s+/);
    if (parts.length >= 2) {
      const m = parts[0].padStart(2, '0');
      const h = parts[1].padStart(2, '0');
      return `${h}:${m}`;
    }
    return defaultTime;
  }

  function formatTime12(timeStr) {
    if (!timeStr) return '';
    const [hStr, mStr] = timeStr.split(':');
    let h = parseInt(hStr, 10);
    const m = mStr || '00';
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${String(h).padStart(2, '0')}:${m} ${ampm}`;
  }

  let scheduleState = null;

  function ensureModalElement() {
    let modal = document.getElementById('schedule-modal');
    if (!modal) {
      const div = document.createElement('div');
      div.id = 'schedule-modal';
      div.className = 'fixed inset-0 z-50 hidden items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4';
      div.innerHTML = `
        <div class="w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden transform transition-all">
          <div class="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
            <div class="flex items-center gap-3">
              <div class="w-9 h-9 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              </div>
              <div>
                <h3 class="text-base font-bold text-slate-900">Automated Run Schedules</h3>
                <p class="text-xs text-slate-500">Cron Scheduler &middot; Asia/Kolkata (IST)</p>
              </div>
            </div>
            <button id="sched-close-btn" type="button" class="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition-colors">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
          </div>

          <div class="p-6 space-y-4 max-h-[75vh] overflow-y-auto custom-scrollbar">
            <!-- Master Enable / Disable Toggle -->
            <div class="flex items-center justify-between p-3.5 rounded-xl bg-slate-50 border border-slate-200/80">
              <div>
                <div class="text-sm font-semibold text-slate-900">Enable Automated Runs</div>
                <div class="text-xs text-slate-500">Background tasks run automatically on schedule with zero extra cost.</div>
              </div>
              <label class="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" id="sched-enabled" class="sr-only peer" checked>
                <div class="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
              </label>
            </div>

            <!-- Flipkart Wallet Job Card -->
            <div class="p-3.5 rounded-xl border border-slate-200 hover:border-indigo-200 transition-colors space-y-2.5">
              <div class="flex items-start justify-between">
                <div class="flex items-center gap-2.5">
                  <div class="w-7 h-7 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center font-bold text-xs">
                    FK
                  </div>
                  <div>
                    <h4 class="text-xs font-bold text-slate-900">Flipkart Ads Wallet (Daily)</h4>
                    <p class="text-[11px] text-slate-500">Syncs balance &amp; daily transactions</p>
                  </div>
                </div>
                <div class="flex items-center gap-1.5">
                  <label for="sched-wallet-time" class="text-[11px] font-medium text-slate-500">Run At (IST):</label>
                  <input type="time" id="sched-wallet-time" value="07:00" class="px-2 py-0.5 text-xs font-semibold bg-white border border-slate-300 rounded-lg text-slate-800" />
                </div>
              </div>
              <div class="flex items-center justify-between text-[10px] text-slate-400 pt-1.5 border-t border-slate-100">
                <span>Frequency: Daily morning</span>
                <span>Last Run: <strong id="sched-wallet-last" class="text-slate-600 font-medium">None yet</strong></span>
              </div>
            </div>

            <!-- Flipkart Trends Job Card -->
            <div class="p-3.5 rounded-xl border border-slate-200 hover:border-indigo-200 transition-colors space-y-2.5">
              <div class="flex items-start justify-between">
                <div class="flex items-center gap-2.5">
                  <div class="w-7 h-7 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center font-bold text-xs">
                    FK
                  </div>
                  <div>
                    <h4 class="text-xs font-bold text-slate-900">Flipkart Search Trends (Weekly)</h4>
                    <p class="text-[11px] text-slate-500">Multi-vertical search volume &amp; rank trends</p>
                  </div>
                </div>
                <div class="flex items-center gap-1.5">
                  <label for="sched-trends-time" class="text-[11px] font-medium text-slate-500">Mondays (IST):</label>
                  <input type="time" id="sched-trends-time" value="08:00" class="px-2 py-0.5 text-xs font-semibold bg-white border border-slate-300 rounded-lg text-slate-800" />
                </div>
              </div>
              <div class="flex items-center justify-between text-[10px] text-slate-400 pt-1.5 border-t border-slate-100">
                <span>Frequency: Weekly Mondays</span>
                <span>Last Run: <strong id="sched-trends-last" class="text-slate-600 font-medium">None yet</strong></span>
              </div>
            </div>

            <!-- Zepto Daily Sync Card -->
            <div class="p-3.5 rounded-xl border border-slate-200 hover:border-fuchsia-200 transition-colors space-y-2.5">
              <div class="flex items-start justify-between">
                <div class="flex items-center gap-2.5">
                  <div class="w-7 h-7 rounded-lg bg-fuchsia-50 text-fuchsia-600 flex items-center justify-center font-bold text-xs">
                    ZP
                  </div>
                  <div>
                    <h4 class="text-xs font-bold text-slate-900">Zepto Daily Sales &amp; Stock Sync</h4>
                    <p class="text-[11px] text-slate-500">Sales_F gap-fill &amp; Vendor Inventory_F refresh</p>
                  </div>
                </div>
                <div class="flex items-center gap-1.5">
                  <label for="sched-zepto-time" class="text-[11px] font-medium text-slate-500">Run At (IST):</label>
                  <input type="time" id="sched-zepto-time" value="14:00" class="px-2 py-0.5 text-xs font-semibold bg-white border border-slate-300 rounded-lg text-slate-800" />
                </div>
              </div>
              <div class="flex items-center justify-between text-[10px] text-slate-400 pt-1.5 border-t border-slate-100">
                <span>Frequency: Daily afternoon</span>
                <span>Last Run: <strong id="sched-zepto-last" class="text-slate-600 font-medium">None yet</strong></span>
              </div>
            </div>

            <div id="sched-status-msg" class="text-xs text-center font-medium"></div>
          </div>

          <div class="px-6 py-3.5 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-3">
            <button id="sched-cancel-btn" type="button" class="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800 rounded-lg hover:bg-slate-100 transition-colors">
              Cancel
            </button>
            <button id="sched-save-btn" type="button" class="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 active:scale-[0.98] rounded-lg shadow-sm transition-all">
              Save Changes
            </button>
          </div>
        </div>
      `;
      document.body.appendChild(div);
      modal = div;
    }
    return modal;
  }

  async function fetchSchedule() {
    try {
      const res = await fetch('/api/schedule');
      if (res.status === 401) {
        window.location.href = '/login?redirect=' + encodeURIComponent(window.location.pathname);
        return null;
      }
      if (!res.ok) throw new Error('Failed to fetch schedule');
      scheduleState = await res.json();
      updateHeaderBadge(scheduleState);
      return scheduleState;
    } catch (err) {
      console.warn('[schedule] Could not load schedule:', err);
      return null;
    }
  }

  function updateHeaderBadge(state) {
    const badge = document.getElementById('schedule-badge');
    const badgeText = document.getElementById('schedule-badge-text');
    if (!badge || !badgeText) return;

    if (!state || !state.enabled) {
      badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-500 border border-slate-200 hover:bg-slate-200 transition-colors cursor-pointer';
      badgeText.textContent = 'Auto-Run: Paused';
      return;
    }

    const path = window.location.pathname;
    if (path.includes('zepto')) {
      const t = cronToTime(state.zepto?.schedule, '14:00');
      badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-fuchsia-50 text-fuchsia-700 border border-fuchsia-200/80 hover:bg-fuchsia-100 transition-colors cursor-pointer';
      badgeText.textContent = `Auto: Daily ${formatTime12(t)} IST`;
    } else if (path.includes('trends')) {
      const t = cronToTime(state.trends?.schedule, '08:00');
      badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200/80 hover:bg-blue-100 transition-colors cursor-pointer';
      badgeText.textContent = `Auto: Mon ${formatTime12(t)} IST`;
    } else {
      const t = cronToTime(state.wallet?.schedule, '07:00');
      badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-200/80 hover:bg-indigo-100 transition-colors cursor-pointer';
      badgeText.textContent = `Auto: Daily ${formatTime12(t)} IST`;
    }
  }

  function openScheduleModal() {
    const modal = ensureModalElement();
    if (!modal) return;

    if (scheduleState) {
      const toggle = document.getElementById('sched-enabled');
      const walletInput = document.getElementById('sched-wallet-time');
      const trendsInput = document.getElementById('sched-trends-time');
      const zeptoInput = document.getElementById('sched-zepto-time');
      const walletLastRun = document.getElementById('sched-wallet-last');
      const trendsLastRun = document.getElementById('sched-trends-last');
      const zeptoLastRun = document.getElementById('sched-zepto-last');

      if (toggle) toggle.checked = Boolean(scheduleState.enabled);
      if (walletInput) walletInput.value = cronToTime(scheduleState.wallet?.schedule, '07:00');
      if (trendsInput) trendsInput.value = cronToTime(scheduleState.trends?.schedule, '08:00');
      if (zeptoInput) zeptoInput.value = cronToTime(scheduleState.zepto?.schedule, '14:00');

      if (walletLastRun) {
        const last = scheduleState.wallet?.lastRun;
        walletLastRun.textContent = last ? `${last.date} ${last.time} (${last.status})` : 'No runs recorded yet';
      }
      if (trendsLastRun) {
        const last = scheduleState.trends?.lastRun;
        trendsLastRun.textContent = last ? `${last.date} ${last.time} (${last.status})` : 'No runs recorded yet';
      }
      if (zeptoLastRun) {
        const last = scheduleState.zepto?.lastRun;
        zeptoLastRun.textContent = last ? `${last.date} ${last.time} (${last.status})` : 'No runs recorded yet';
      }
    }

    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }

  function closeScheduleModal() {
    const modal = document.getElementById('schedule-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }

  async function saveSchedule(e) {
    if (e) e.preventDefault();
    const saveBtn = document.getElementById('sched-save-btn');
    const toggle = document.getElementById('sched-enabled');
    const walletInput = document.getElementById('sched-wallet-time');
    const trendsInput = document.getElementById('sched-trends-time');
    const zeptoInput = document.getElementById('sched-zepto-time');
    const statusMsg = document.getElementById('sched-status-msg');

    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
    }

    try {
      const payload = {
        enabled: toggle ? toggle.checked : true,
        walletTime: walletInput ? walletInput.value : '07:00',
        trendsTime: trendsInput ? trendsInput.value : '08:00',
        zeptoTime: zeptoInput ? zeptoInput.value : '14:00',
      };

      const res = await fetch('/api/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.status === 401) {
        window.location.href = '/login?redirect=' + encodeURIComponent(window.location.pathname);
        return;
      }
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to update schedule');
      }
      const data = await res.json();
      if (data.schedule) {
        scheduleState = data.schedule;
        updateHeaderBadge(scheduleState);
      }

      if (statusMsg) {
        statusMsg.textContent = 'Schedule updated successfully!';
        statusMsg.className = 'text-xs font-medium text-emerald-600';
        setTimeout(() => { statusMsg.textContent = ''; }, 3000);
      }

      setTimeout(() => {
        closeScheduleModal();
      }, 600);
    } catch (err) {
      if (statusMsg) {
        statusMsg.textContent = `Error: ${err.message}`;
        statusMsg.className = 'text-xs font-medium text-rose-600';
      }
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Changes';
      }
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    ensureModalElement();
    fetchSchedule();

    const badge = document.getElementById('schedule-badge');
    const openBtn = document.getElementById('open-schedule-btn');

    if (badge) badge.addEventListener('click', openScheduleModal);
    if (openBtn) openBtn.addEventListener('click', (e) => { e.preventDefault(); openScheduleModal(); });

    document.addEventListener('click', (e) => {
      if (e.target && (e.target.id === 'sched-close-btn' || e.target.closest('#sched-close-btn'))) closeScheduleModal();
      if (e.target && e.target.id === 'sched-cancel-btn') closeScheduleModal();
      if (e.target && e.target.id === 'sched-save-btn') saveSchedule(e);
      const modal = document.getElementById('schedule-modal');
      if (modal && e.target === modal) closeScheduleModal();
    });

    window.addEventListener('keydown', (e) => {
      const modal = document.getElementById('schedule-modal');
      if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
        closeScheduleModal();
      }
    });
  });

  window.scheduleModal = {
    open: openScheduleModal,
    close: closeScheduleModal,
    refresh: fetchSchedule,
  };
})();
