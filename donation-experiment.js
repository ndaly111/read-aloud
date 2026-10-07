/* Donation appeal A/B experiment. Defaults to existing appeal unless goal data is verified. */
(() => {
  'use strict';
  const EXPERIMENT_ID = 'support_goal_2026_10';
  const ENDPOINT = 'https://read-aloud-donation-goal.ndaly111.workers.dev/goal';
  const STORAGE_KEY = 'ra_support_exp_202610';
  const CONSENT_KEY = 'ra_cookie_consent';
  const bar = document.getElementById('supportBar');
  if (!bar) return;

  function track(eventName, variant) {
    // No personal identifiers, pasted text or document content are sent.
    if (typeof window.gtag === 'function') {
      window.gtag('event', eventName, {
        experiment_id: EXPERIMENT_ID,
        variant_id: variant
      });
    }
  }

  function pickVariant() {
    let stored = null;
    try {
      stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored !== 'A' && stored !== 'B' && localStorage.getItem(CONSENT_KEY) === 'accepted') {
        stored = localStorage.getItem(STORAGE_KEY);
      }
      if (stored !== 'A' && stored !== 'B') {
        const bytes = new Uint8Array(1);
        crypto.getRandomValues(bytes);
        stored = bytes[0] < 128 ? 'A' : 'B';
      }
      sessionStorage.setItem(STORAGE_KEY, stored);
      // Only retain the assignment across browser sessions after analytics consent.
      if (localStorage.getItem(CONSENT_KEY) === 'accepted') {
        localStorage.setItem(STORAGE_KEY, stored);
      }
    } catch (_) {
      stored = Math.random() < 0.5 ? 'A' : 'B';
    }
    return stored;
  }

  function showGoal(data) {
    const message = bar.querySelector('.msg');
    const link = bar.querySelector('.coffeeBtn');
    if (!message || !link) return false;

    const dollars = cents => new Intl.NumberFormat('en-US', {
      style: 'currency', currency: 'USD', maximumFractionDigits: 0
    }).format(cents / 100);
    const raised = Math.max(0, data.raised_cents);
    const target = data.goal_cents;
    message.textContent = 'Help keep Read-Aloud free. Your support helps cover the cost of running the service.';
    const goal = document.createElement('div');
    goal.className = 'support-goal';
    const totals = document.createElement('span');
    totals.className = 'support-goal__totals';
    totals.textContent = dollars(raised) + ' of ' + dollars(target) + ' ' + data.month_label + ' goal (verified one-time USD gifts)';
    const progress = document.createElement('progress');
    progress.className = 'support-goal__progress';
    progress.max = target;
    progress.value = Math.min(raised, target);
    progress.setAttribute('aria-label', 'Verified monthly support progress');
    goal.append(totals, progress);
    link.textContent = 'Support Read-Aloud';
    link.setAttribute('aria-label', 'Support Read-Aloud on Buy Me a Coffee');
    bar.insertBefore(goal, link);
    bar.classList.add('support-bar--goal');
    // The public value is aggregated and never includes supporter details.
    return true;
  }

  async function init() {
    try {
      const response = await fetch(ENDPOINT, { mode: 'cors', cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      if (data.ready !== true || data.currency !== 'USD' ||
          data.data_scope !== 'verified_one_time_usd_donations' ||
          !Number.isSafeInteger(data.goal_cents) || data.goal_cents <= 0 ||
          !Number.isSafeInteger(data.raised_cents) || data.raised_cents < 0 ||
          !/^[A-Za-z]+ 20\d\d$/.test(data.month_label)) return;

      const variant = pickVariant();
      if (variant === 'B' && !showGoal(data)) return;
      bar.dataset.donationVariant = variant;
      track('donation_experiment_view', variant);
      const link = bar.querySelector('.coffeeBtn');
      if (link) link.addEventListener('click', () => track('donation_experiment_click', variant));
    } catch (_) {
      // Network failures must never interfere with the reading tool or existing support link.
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();