# Sitemap and robots.txt maintenance

## Purpose
The sitemap (`sitemap.xml`) lists canonical, indexable, public pages so crawlers can quickly discover and refresh content. It is intended for the production host at `https://read-aloud.com`.

## Canonical host rule (MUST be consistent)
- Canonical base URL: `https://read-aloud.com`
- All `<loc>` values must use the canonical host.
- Sitemap URLs must be absolute (begin with `https://`), never relative.
- Preferred behavior: configure hosting/CDN to 301 redirect `https://www.read-aloud.com/*` to `https://read-aloud.com/*` (or the reverse if you intentionally pick `www` as canonical). If redirects live outside this repo, capture the requirement in ops runbooks.

**Current host check:** automated curl checks from this environment receive a `403` when requesting both `https://read-aloud.com/` and `https://www.read-aloud.com/`, so the redirect behavior could not be confirmed here. Operations should verify that `www.read-aloud.com` issues a 301/308 to `https://read-aloud.com/` at the hosting/CDN layer.

## What belongs in the sitemap
Include only pages that are:
- Public and meant to be indexed
- Returning HTTP 200
- Not redirects
- Not marked `noindex`
- Not duplicates/typos/aliases unless intentionally canonical

Do **not** include:
- Typo URLs (e.g., `benifits.html` if it only exists as a misspelling/redirect)
- Dev/test pages
- Old/deleted pages
- Duplicate variants (e.g., both `/` and `/index.html` unless you want both indexed)

## URL formatting rules
- Exactly one `<loc>` per `<url>` entry.
- Trailing slash policy: use `https://read-aloud.com/` for the root; other pages should follow the site pattern (e.g., `.../page.html`).
- Keep entries stable and readable: one `<url>` block per entry with consistent indentation.

## Field rules
- `<lastmod>` must be `YYYY-MM-DD` and should reflect real content changes (do not auto-update without changes).
- `<changefreq>`: use conservative defaults (weekly is fine for mostly-static pages).
- `<priority>`: treat as relative importance and keep values stable; avoid over-optimizing.

## Update procedure
When adding or removing a page:
1. Add the page’s canonical URL to `sitemap.xml`.
2. Set or adjust its `<lastmod>` to reflect the latest content change.
3. Ensure the page is internally linked (recommended).
4. Remove sitemap entries for deleted pages.
5. If you rename or move a page, update the sitemap to the new URL and ensure the old URL redirects appropriately.

## Validation checklist
Run this checklist before merging changes:
- Sitemap is well-formed XML.
- No `<url>` entry contains more than one `<loc>`.
- All `<loc>` URLs use the canonical host.
- All sitemap URLs return HTTP 200 and do not redirect away from their canonical forms.
- No sitemap URL contains `noindex`.
- `robots.txt` references the correct sitemap URL.
- Sitemap excludes known typos, redirects, and duplicates.
- The non-canonical host redirects to the canonical host, or every page publishes a canonical tag pointing to the canonical host.

## How to test
A helper script exists at `scripts/verify_sitemap_urls.py`.
- Run: `python scripts/verify_sitemap_urls.py`
- It fetches `sitemap.xml`, checks each URL for HTTP 200 responses, flags redirects away from the requested URL, and flags any pages containing `noindex`.
- If it reports failures, either fix the page (serve 200 without `noindex`) or remove/update the sitemap entry accordingly.

## robots.txt rules
- Keep `robots.txt` minimal and allow crawling by default (empty `Disallow:` or explicit `Allow: /`).
- Include a `Sitemap:` line pointing to the canonical sitemap URL: `Sitemap: https://read-aloud.com/sitemap.xml`.
- Place `robots.txt` at the repo root so it is served from `/robots.txt` in production.
