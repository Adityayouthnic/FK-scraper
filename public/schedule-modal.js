/**
 * Schedule Modal & Status Manager
 * Handles fetching, displaying, and updating auto-run schedules.
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

  async function fetchSchedule() {
    try {
      const res = await fetch('/api/schedule');
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
      badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-500 border border-slate-200 hover:bg-slate-200 transition-colors cursor-pointer';
      badgeText.textContent = 'Auto-Run: Paused';
      return;
    }

    const isTrendsPage = window.location.pathname.includes('trends');
    if (isTrendsPage) {
      const t = cronToTime(state.trends?.schedule, '08:00');
      badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-200/80 hover:bg-indigo-100 transition-colors cursor-pointer';
      badgeText.textContent = `Auto: Mon ${formatTime12(t)} IST`;
    } else {
      const t = cronToTime(state.wallet?.schedule, '07:00');
      badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-200/80 hover:bg-indigo-100 transition-colors cursor-pointer';
      badgeText.textContent = `Auto: Daily ${formatTime12(t)} IST`;
    }
  }

  function openScheduleModal() {
    const modal = document.getElementById('schedule-modal');
    if (!modal) return;

    if (scheduleState) {
      const toggle = document.getElementById('sched-enabled');
      const walletInput = document.getElementById('sched-wallet-time');
      const trendsInput = document.getElementById('sched-trends-time');
      const walletLastRun = document.getElementById('sched-wallet-last');
      const trendsLastRun = document.getElementById('sched-trends-last');

      if (toggle) toggle.checked = Boolean(scheduleState.enabled);
      if (walletInput) walletInput.value = cronToTime(scheduleState.wallet?.schedule, '07:00');
      if (trendsInput) trendsInput.value = cronToTime(scheduleState.trends?.schedule, '08:00');

      if (walletLastRun) {
        const last = scheduleState.wallet?.lastRun;
        walletLastRun.textContent = last ? `${last.date} ${last.time} (${last.status})` : 'No runs recorded yet';
      }
      if (trendsLastRun) {
        const last = scheduleState.trends?.lastRun;
        trendsLastRun.textContent = last ? `${last.date} ${last.time} (${last.status})` : 'No runs recorded yet';
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
      };

      const res = await fetch('/api/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error('Failed to update schedule');
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

  // Hook up event listeners once DOM is ready
  document.addEventListener('DOMContentLoaded', () => {
    fetchSchedule();

    const badge = document.getElementById('schedule-badge');
    const openBtn = document.getElementById('open-schedule-btn');
    const closeBtn = document.getElementById('sched-close-btn');
    const cancelBtn = document.getElementById('sched-cancel-btn');
    const saveBtn = document.getElementById('sched-save-btn');
    const modal = document.getElementById('schedule-modal');

    if (badge) badge.addEventListener('click', openScheduleModal);
    if (openBtn) openBtn.addEventListener('click', (e) => { e.preventDefault(); openScheduleModal(); });
    if (closeBtn) closeBtn.addEventListener('click', closeScheduleModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeScheduleModal);
    if (saveBtn) saveBtn.addEventListener('click', saveSchedule);

    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeScheduleModal();
      });
    }

    // Escape key closes modal
    window.addEventListener('keydown', (e) => {
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
