/* Donation appeal experiment: existing appeal, $50 goal, $100 goal. */
(() => {
  'use strict';
  const EXPERIMENT_ID = 'support_goal_2026_10';
  const ORIGIN = 'https://read-aloud-donation-goal.ndaly111.workers.dev';
  const ENDPOINT = ORIGIN + '/goal';
  const EVENT_ENDPOINT = ORIGIN + '/event';
  const STORAGE_KEY = 'ra_support_exp_202610';
  const CONSENT_KEY = 'ra_cookie_consent';
  const VARIANTS = ['A', 'B', 'C'];
  // GA4 event name -> the experiment's own counter name.
  const COUNTERS = {
    donation_experiment_view: 'view', donation_experiment_click: 'click',
    donation_support_view: 'rollout_view', donation_support_click: 'rollout_click'
  };
  let assignment = null;
  let consent = readStorage('localStorage', CONSENT_KEY);
  const bar = document.getElementById('supportBar');
  if (!bar) return;

  function readStorage(type, key) {
    try { return window[type].getItem(key); } catch (_) { return null; }
  }
  function writeStorage(type, value) {
    try {
      if (value === null) window[type].removeItem(STORAGE_KEY);
      else window[type].setItem(STORAGE_KEY, value);
    } catch (_) {}
  }
  function syncConsent(value) {
    consent = value;
    if (consent !== 'accepted') writeStorage('localStorage', null);
    else if (assignment) writeStorage('localStorage', assignment);
  }
  window.addEventListener('ra-consent-change', event => syncConsent(event.detail));
  window.addEventListener('storage', event => {
    if (event.key === CONSENT_KEY || event.key === null) {
      syncConsent(readStorage('localStorage', CONSENT_KEY));
    }
  });

  function track(eventName, variant) {
    // No personal identifiers, pasted text or document content are sent.
    if (typeof window.gtag === 'function') {
      window.gtag('event', eventName, {
        experiment_id: EXPERIMENT_ID,
        variant_id: variant
      });
    }
    // The experiment's own aggregate counter. GA4 custom dimensions are not
    // retroactive and ad blockers drop gtag entirely, so this is the measurement
    // of record. It counts events only: no identifiers, cookies or page content.
    const counter = COUNTERS[eventName];
    if (!counter) return;
    const body = JSON.stringify({ experiment_id: EXPERIMENT_ID, variant, event: counter });
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(EVENT_ENDPOINT,
        new Blob([body], { type: 'application/json' }))) return;
      fetch(EVENT_ENDPOINT, { method: 'POST', body, mode: 'cors', credentials: 'omit',
        keepalive: true, referrerPolicy: 'no-referrer',
        headers: { 'content-type': 'application/json' } }).catch(() => {});
    } catch (_) {}
  }

  function pickVariant() {
    let stored = consent === 'accepted' ? readStorage('localStorage', STORAGE_KEY) : null;
    if (!VARIANTS.includes(stored)) stored = readStorage('sessionStorage', STORAGE_KEY);
    if (!VARIANTS.includes(stored)) {
      const bytes = new Uint8Array(1);
      // Reject the last byte value so all three groups get exactly equal odds.
      do { window.crypto.getRandomValues(bytes); } while (bytes[0] === 255);
      stored = VARIANTS[bytes[0] % VARIANTS.length];
    }
    assignment = stored;
    writeStorage('sessionStorage', stored);
    // Only retain the assignment across browser sessions after analytics consent.
    syncConsent(consent);
    return stored;
  }

  function showGoal(data, variant) {
    const message = bar.querySelector('.msg');
    const link = bar.querySelector('.coffeeBtn');
    if (!message || !link) return false;

    const dollars = cents => new Intl.NumberFormat('en-US', {
      style: 'currency', currency: 'USD', minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2
    }).format(cents / 100);
    const target = data.goals_cents[variant];
    message.textContent = 'Help keep Read-Aloud free. Your support helps cover the cost of running the service.';
    const goal = document.createElement('div');
    goal.className = 'support-goal';
    const totals = document.createElement('span');
    totals.className = 'support-goal__totals';
    if (data.totals_verified === true) {
      // Reconciled ledger month: show real month-to-date progress.
      const raised = Math.max(0, data.raised_cents);
      const progress = document.createElement('progress');
      progress.className = 'support-goal__progress';
      progress.max = target;
      progress.value = Math.min(raised, target);
      progress.setAttribute('aria-label', 'Verified monthly support progress');
      const scope = document.createElement('small');
      scope.className = 'support-goal__scope';
      scope.textContent = 'Verified one-time USD gifts, less refunds';
      totals.textContent = dollars(raised) + ' of ' + dollars(target) + ' · ' + data.month_label;
      goal.append(totals, progress, scope);
    } else {
      // No reconciled ledger: state the target only. No raised amount is shown or implied.
      goal.classList.add('support-goal--target-only');
      totals.textContent = 'Monthly goal: ' + dollars(target) + ' · ' + data.month_label;
      goal.append(totals);
    }
    link.textContent = 'Support Read-Aloud';
    link.setAttribute('aria-label', 'Support Read-Aloud on Buy Me a Coffee');
    bar.insertBefore(goal, link);
    bar.classList.add('support-bar--goal');
    // Any published value is aggregated and never includes supporter details.
    return true;
  }

  async function init() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(ENDPOINT, { mode: 'cors', cache: 'no-store',
        credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
      if (!response.ok) return;
      const data = await response.json();
      const now = Date.now();
      const asOf = Date.parse(data.as_of);
      const launch = Date.parse(data.launch_at);
      const month = new Intl.DateTimeFormat('en-US', {
        month: 'long', year: 'numeric', timeZone: 'UTC'
      }).format(new Date(now));
      if (data.ready !== true ||
          data.experiment_id !== EXPERIMENT_ID || data.currency !== 'USD' ||
          data.data_scope !== 'verified_one_time_usd_donations' ||
          data.goals_cents?.B !== 5000 || data.goals_cents?.C !== 10000 ||
          typeof data.totals_verified !== 'boolean' ||
          data.month_label !== month || !Number.isFinite(asOf) ||
          asOf > now + 60000 || now - asOf > 300000) return;
      // A claimed total must be a real integer amount; otherwise no total is published.
      if (data.totals_verified
        ? !Number.isSafeInteger(data.raised_cents) || data.raised_cents < 0
        : data.raised_cents != null) return;

      const rollout = data.rollout_variant;
      // A winner takes priority over saved assignments and the experiment's time limit.
      // Separate event names keep post-rollout visits out of experimental results.
      if (rollout != null) {
        if (!VARIANTS.includes(rollout)) return;
        if (rollout !== 'A' && !showGoal(data, rollout)) return;
        bar.dataset.donationVariant = rollout;
        bar.dataset.donationMode = 'rollout';
        track('donation_support_view', rollout);
        const link = bar.querySelector('.coffeeBtn');
        if (link) link.addEventListener('click', () => track('donation_support_click', rollout));
        return;
      }
      if (data.experiment_active !== true || !Number.isFinite(launch) ||
          launch > now || now - launch >= 42 * 86400000) return;

      const variant = pickVariant();
      if (variant !== 'A' && !showGoal(data, variant)) return;
      bar.dataset.donationVariant = variant;
      bar.dataset.donationMode = 'experiment';
      track('donation_experiment_view', variant);
      const link = bar.querySelector('.coffeeBtn');
      if (link) link.addEventListener('click', () => track('donation_experiment_click', variant));
    } catch (_) {
      // Network failures must never interfere with the reading tool or existing support link.
    } finally { clearTimeout(timeout); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
