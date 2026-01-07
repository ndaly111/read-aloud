(() => {
  const GA_MEASUREMENT_ID = "G-SVGML1VGPG";
  const ADSENSE_CLIENT = "ca-pub-4003447295960802";

  function loadScript(src, attrs = {}) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      Object.entries(attrs).forEach(([k, v]) => s.setAttribute(k, v));
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async function enableTags() {
    window.dataLayer = window.dataLayer || [];
    window.gtag =
      window.gtag ||
      function () {
        window.dataLayer.push(arguments);
      };

    await loadScript(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_MEASUREMENT_ID)}`);
    window.gtag("js", new Date());
    window.gtag("config", GA_MEASUREMENT_ID);

    const ads = document.querySelectorAll(".adsbygoogle");
    if (ads.length) {
      await loadScript(
        `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(ADSENSE_CLIENT)}`,
        { crossorigin: "anonymous" }
      );
      ads.forEach(() => {
        try {
          (window.adsbygoogle = window.adsbygoogle || []).push({});
        } catch {}
      });
    }
  }

  function onConsent(choice) {
    if (choice === "accepted") enableTags().catch(() => {});
  }

  window.addEventListener("cookie-consent", (e) => onConsent(e.detail.choice));

  try {
    const stored = localStorage.getItem("ra_cookie_consent_v1");
    if (stored) onConsent(stored);
  } catch {}
})();
