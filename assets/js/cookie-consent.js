(() => {
  const KEY = "ra_cookie_consent_v1"; // "accepted" | "declined"
  const prefix = window.__SITE_PREFIX__ || "";
  const privacyHref = prefix + "privacy.html";

  function getChoice() {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  }
  function setChoice(v) {
    try {
      localStorage.setItem(KEY, v);
    } catch {}
    window.dispatchEvent(new CustomEvent("cookie-consent", { detail: { choice: v } }));
  }

  const existing = getChoice();
  if (existing === "accepted" || existing === "declined") {
    window.dispatchEvent(new CustomEvent("cookie-consent", { detail: { choice: existing } }));
    return;
  }

  const banner = document.createElement("div");
  banner.className = "cookie-banner";
  banner.setAttribute("role", "dialog");
  banner.setAttribute("aria-label", "Cookie consent");
  banner.innerHTML = `
    <div class="cookie-inner">
      <div class="cookie-text">
        <strong>Cookies:</strong> We use cookies and similar storage for analytics and advertising. You can accept or decline.
        <a href="${privacyHref}">Learn more</a>.
      </div>
      <div class="cookie-actions">
        <button class="btn btn-primary" type="button" data-action="accept">Accept</button>
        <button class="btn" type="button" data-action="decline">Decline</button>
      </div>
    </div>
  `;

  banner.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    const choice = action === "accept" ? "accepted" : "declined";
    setChoice(choice);
    banner.remove();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      setChoice("declined");
      banner.remove();
    }
  });

  document.addEventListener("DOMContentLoaded", () => {
    document.body.appendChild(banner);
  });
})();
