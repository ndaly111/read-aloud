"""
Verify sitemap URLs for canonical host, HTTP 200 responses, and absence of `noindex`.
Supports reading a local sitemap.xml file by default when present, or fetching a remote URL.
"""
from __future__ import annotations

import pathlib
import sys
import urllib.request
import xml.etree.ElementTree as ET
from typing import Iterable, List, Tuple

CANONICAL_HOST = "https://read-aloud.com"
DEFAULT_REMOTE = f"{CANONICAL_HOST}/sitemap.xml"
USER_AGENT = "Mozilla/5.0 (compatible; ReadAloudSiteCheck/1.0)"


def fetch_bytes(target: str) -> bytes:
    request = urllib.request.Request(target, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request) as resp:  # nosec: B310
        return resp.read()


def load_urls(source: str | None = None) -> List[str]:
    sitemap_source = source
    if sitemap_source is None:
        local_path = pathlib.Path("sitemap.xml")
        sitemap_source = str(local_path) if local_path.exists() else DEFAULT_REMOTE

    if pathlib.Path(sitemap_source).exists():
        content = pathlib.Path(sitemap_source).read_bytes()
    else:
        content = fetch_bytes(sitemap_source)

    root = ET.fromstring(content)
    ns = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    urls = [
        loc.text.strip()
        for loc in root.findall(".//sm:url/sm:loc", ns)
        if loc.text and loc.text.strip()
    ]
    return urls


def check_urls(urls: Iterable[str]) -> List[Tuple[str, str]]:
    failures: List[Tuple[str, str]] = []
    for url in urls:
        if not url.startswith(CANONICAL_HOST):
            failures.append((url, "non-canonical host"))
            continue

        note = ""
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request) as resp:  # nosec: B310
                final_url = resp.geturl()
                status = resp.status
                body = resp.read().lower()
            if final_url and final_url != url:
                note = f"redirected to {final_url}"
            elif status != 200:
                note = f"unexpected status {status}"
            elif b"noindex" in body:
                note = "page contains 'noindex'"
        except Exception as exc:  # noqa: BLE001
            note = f"error fetching: {exc}"

        if note:
            failures.append((url, note))
    return failures


def main(args: list[str] | None = None) -> int:
    sitemap_arg = args[0] if args else None
    urls = load_urls(sitemap_arg)
    failures = check_urls(urls)
    if failures:
        print("Found issues with the following URLs:")
        for url, note in failures:
            print(f"- {url}: {note}")
        return 1
    print(f"All {len(urls)} URLs validated on {CANONICAL_HOST} without redirects or 'noindex'.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
