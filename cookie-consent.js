(() => {
  const CONSENT_KEY = 'ra_cookie_consent';
  const ACCEPTED = 'accepted';
  const REJECTED = 'rejected';
  const GA_ID = 'G-SVGML1VGPG';

  const loadScript = (src, attrs = {}) => {
    const script = document.createElement('script');
    script.async = true;
    script.src = src;
    Object.entries(attrs).forEach(([key, value]) => {
      if (value !== undefined) {
        script.setAttribute(key, value);
      }
    });
    document.head.appendChild(script);
    return script;
  };

  const initAnalytics = () => {
    if (window.__raAnalyticsLoaded) return;
    window.__raAnalyticsLoaded = true;
    loadScript(`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`);
    window.dataLayer = window.dataLayer || [];
    function gtag(){window.dataLayer.push(arguments);}
    window.gtag = window.gtag || gtag;
    window.gtag('js', new Date());
    window.gtag('config', GA_ID);
  };

  const initAdsense = () => {
    const slot = document.getElementById('adsense-slot');
    if (!slot || window.__raAdsenseLoaded) return;
    window.__raAdsenseLoaded = true;
    const adClient = slot.dataset.adClient;
    const adSlot = slot.dataset.adSlot;
    if (!adClient || !adSlot) return;

    loadScript(`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${adClient}`, {
      crossorigin: 'anonymous',
    });

    slot.textContent = '';
    const ins = document.createElement('ins');
    ins.className = 'adsbygoogle';
    ins.style.display = 'inline-block';
    if (slot.dataset.adWidth && slot.dataset.adHeight) {
      ins.style.width = `${slot.dataset.adWidth}px`;
      ins.style.height = `${slot.dataset.adHeight}px`;
    }
    ins.dataset.adClient = adClient;
    ins.dataset.adSlot = adSlot;
    slot.appendChild(ins);
    (window.adsbygoogle = window.adsbygoogle || []).push({});
  };

  const applyConsent = (value) => {
    if (value === ACCEPTED) {
      initAnalytics();
      initAdsense();
    }
  };

  const buildBanner = () => {
    const banner = document.createElement('div');
    banner.className = 'cookie-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-live', 'polite');
    banner.innerHTML = `
      <div>
        <strong>Privacy settings</strong>
        <p>We only load analytics and ads if you accept. You can update your choice anytime in <a href="/privacy.html">Privacy</a>.</p>
      </div>
      <div class="cookie-banner__actions">
        <button type="button" class="secondary" data-consent="reject">Reject</button>
        <button type="button" data-consent="accept">Accept</button>
      </div>
    `;
    banner.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-consent]');
      if (!button) return;
      const choice = button.dataset.consent === 'accept' ? ACCEPTED : REJECTED;
      localStorage.setItem(CONSENT_KEY, choice);
      banner.remove();
      applyConsent(choice);
    });
    return banner;
  };

  const showBanner = () => {
    if (document.querySelector('.cookie-banner')) return;
    document.body.appendChild(buildBanner());
  };

  const setupReset = () => {
    document.querySelectorAll('[data-cookie-reset]').forEach((button) => {
      button.addEventListener('click', () => {
        localStorage.removeItem(CONSENT_KEY);
        showBanner();
      });
    });
  };

  const init = () => {
    const stored = localStorage.getItem(CONSENT_KEY);
    if (!stored) {
      showBanner();
    } else {
      applyConsent(stored);
    }
    setupReset();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
