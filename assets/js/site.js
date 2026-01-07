(() => {
  function getPrefixToRoot() {
    const path = window.location.pathname;
    const parts = path.split("/").filter(Boolean);

    const repoName = "read-aloud";
    const hasRepoBase = parts[0] === repoName;
    const start = hasRepoBase ? 1 : 0;

    const last = parts[parts.length - 1] || "";
    const isFile = last.includes(".");
    const depth = Math.max(0, parts.length - start - (isFile ? 1 : 0));
    return "../".repeat(depth);
  }

  const prefix = getPrefixToRoot();
  const href = (p) => prefix + p.replace(/^\//, "");

  const navLinks = [
    { label: "Tool", href: href("index.html") },
    { label: "Guides", href: href("guides.html") },
    { label: "Voices", href: href("voices.html") },
    { label: "Help", href: href("help.html") },
    { label: "Blog", href: href("blog/index.html") },
    { label: "About", href: href("about.html") },
  ];

  const footerLinks = [
    { label: "Contact", href: href("contact.html") },
    { label: "Updates", href: href("updates/index.html") },
    { label: "Resources", href: href("recommendations.html") },
    { label: "Privacy", href: href("privacy.html") },
    { label: "Terms", href: href("terms.html") },
  ];

  function normalizePathname(pathname) {
    if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
    return pathname;
  }

  function isCurrent(linkHref) {
    const a = document.createElement("a");
    a.href = linkHref;
    const linkPath = normalizePathname(a.pathname);
    const currentPath = normalizePathname(window.location.pathname);

    if (currentPath.endsWith("/") && linkPath.endsWith("/index.html")) return true;
    return currentPath === linkPath;
  }

  function renderNav(links) {
    return links
      .map((l) => {
        const current = isCurrent(l.href);
        return `<a href="${l.href}" ${current ? 'aria-current="page"' : ""}>${l.label}</a>`;
      })
      .join("");
  }

  function mountLayout() {
    const header = document.getElementById("siteHeader");
    const footer = document.getElementById("siteFooter");
    if (header) {
      header.className = "site-header";
      header.innerHTML = `
        <div class="container">
          <div class="header-inner">
            <a class="brand" href="${href("index.html")}">
              <span class="brand-badge" aria-hidden="true"></span>
              <span>Read‑Aloud</span>
            </a>
            <nav class="nav" aria-label="Primary">
              ${renderNav(navLinks)}
            </nav>
          </div>
        </div>
      `;
    }
    if (footer) {
      footer.className = "site-footer";
      footer.innerHTML = `
        <div class="container">
          <div class="footer-inner">
            <div class="footer-links" aria-label="Footer">
              ${footerLinks.map((l) => `<a href="${l.href}">${l.label}</a>`).join("")}
            </div>
            <div>© ${new Date().getFullYear()} Read‑Aloud</div>
          </div>
        </div>
      `;
    }
  }

  window.__SITE_PREFIX__ = prefix;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountLayout);
  } else {
    mountLayout();
  }
})();
