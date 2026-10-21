"""
Fetch a web page and pull out its readable article text ("reader view").

The server fetches on the reader's behalf because browsers cannot read other
sites' pages directly. It runs on a home network, so every hop (including
redirects) is resolved first and refused unless all addresses are public, and
the connection goes to the vetted address itself so a second DNS answer cannot
point it somewhere private.
"""

import asyncio
import ipaddress
import socket
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx

try:
    import trafilatura
except ImportError:          # extraction disabled; the endpoint reports it
    trafilatura = None

MAX_URL_LEN = 2048
MAX_REDIRECTS = 5
MAX_BYTES = 5 * 1024 * 1024
TIMEOUT = httpx.Timeout(10.0, connect=5.0)
HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"),
    "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
    "Accept-Language": "en-US,en;q=0.9",
}


class ExtractError(Exception):
    """A failure whose message is safe and useful to show the reader."""

    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


def available() -> bool:
    return trafilatura is not None


async def _public_address(host: str, port: int) -> str:
    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror:
        raise ExtractError("That website address couldn't be found.", 400)
    addrs = {info[4][0] for info in infos}
    if not addrs:
        raise ExtractError("That website address couldn't be found.", 400)
    for addr in addrs:
        ip = ipaddress.ip_address(addr.split("%")[0])
        if not ip.is_global or ip.is_multicast:
            raise ExtractError("That link points to a private address.", 400)
    return sorted(addrs)[0]


def _check_url(url: str):
    if len(url) > MAX_URL_LEN:
        raise ExtractError("That link is too long.", 400)
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ExtractError("Paste a full web link starting with http:// or https://.", 400)
    if parts.username or parts.password:
        raise ExtractError("Links with a username or password aren't supported.", 400)
    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError:
        raise ExtractError("That link has an invalid port.", 400)
    if port not in (80, 443):
        raise ExtractError("Only standard web links are supported.", 400)
    return parts, port


async def _fetch_html(url: str):
    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=False,
                                 trust_env=False) as client:
        for _ in range(MAX_REDIRECTS + 1):
            parts, port = _check_url(url)
            host = parts.hostname
            addr = await _public_address(host, port)
            netloc = f"[{addr}]" if ":" in addr else addr
            if parts.port:
                netloc += f":{parts.port}"
            target = urlunsplit((parts.scheme, netloc, parts.path or "/", parts.query, ""))
            headers = dict(HEADERS, Host=parts.netloc.rsplit("@", 1)[-1])
            extensions = {"sni_hostname": host} if parts.scheme == "https" else {}
            try:
                req = client.build_request("GET", target, headers=headers, extensions=extensions)
                resp = await client.send(req, stream=True)
            except httpx.TimeoutException:
                raise ExtractError("That website took too long to respond.", 504)
            except httpx.HTTPError:
                raise ExtractError("Couldn't connect to that website.", 502)
            try:
                if resp.status_code in (301, 302, 303, 307, 308) and "location" in resp.headers:
                    url = urljoin(url, resp.headers["location"])
                    continue
                if resp.status_code in (401, 402, 403, 451):
                    raise ExtractError("That website blocked the request — it may need a "
                                       "login or subscription. Copy and paste the text instead.", 502)
                if resp.status_code >= 400:
                    raise ExtractError(f"That website returned an error ({resp.status_code}).", 502)
                ctype = resp.headers.get("content-type", "").lower()
                if ctype and "html" not in ctype:
                    if "pdf" in ctype:
                        raise ExtractError("That link is a PDF — download it and use Upload a file.", 422)
                    raise ExtractError("That link isn't a web page.", 422)
                body = bytearray()
                async for chunk in resp.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > MAX_BYTES:
                        raise ExtractError("That page is too large to read.", 422)
                encoding = resp.charset_encoding or "utf-8"
                try:
                    html = bytes(body).decode(encoding, errors="replace")
                except LookupError:
                    html = bytes(body).decode("utf-8", errors="replace")
                return html, url
            finally:
                await resp.aclose()
    raise ExtractError("That link redirected too many times.", 502)


def _extract(html: str, url: str) -> dict:
    text = trafilatura.extract(html, url=url, output_format="txt",
                               include_comments=False, include_tables=False,
                               include_images=False, deduplicate=True)
    meta = trafilatura.extract_metadata(html, default_url=url)
    title = (meta.title or "").strip() if meta else ""
    if not text or len(text.split()) < 40:
        raise ExtractError("Couldn't find an article on that page. If it needs a login, "
                           "copy and paste the text instead.", 422)
    paragraphs = [p.strip() for p in text.splitlines() if p.strip()]
    if title and paragraphs and paragraphs[0].lower() == title.lower():
        paragraphs = paragraphs[1:]
    body = "\n\n".join(paragraphs)
    return {"title": title, "text": (title + "\n\n" + body) if title else body, "url": url}


async def fetch_article(url: str) -> dict:
    if trafilatura is None:
        raise ExtractError("Reading from a link isn't available right now.", 503)
    html, final_url = await _fetch_html(url.strip())
    return await asyncio.to_thread(_extract, html, final_url)
