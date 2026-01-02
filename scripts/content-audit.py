#!/usr/bin/env python3
"""
Content audit helper for read-aloud.com.

Scans HTML/Markdown files under the project directory, extracts visible text,
counts words, and reports thin pages (<250 words).

Usage:
  python scripts/content-audit.py [--root PATH] [--output FILE]

Examples:
  python scripts/content-audit.py
  python scripts/content-audit.py --root . --output scripts/reports/content-audit-before.txt
"""
import argparse
import html
import os
import re
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path

EXTS = {".html", ".htm", ".md", ".mdx"}

SCRIPT_RE = re.compile(r"<script.*?</script>", re.IGNORECASE | re.DOTALL)
STYLE_RE = re.compile(r"<style.*?</style>", re.IGNORECASE | re.DOTALL)
TITLE_RE = re.compile(r"<title>(.*?)</title>", re.IGNORECASE | re.DOTALL)


class TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.chunks = []

    def handle_data(self, data):
        cleaned = data.strip()
        if cleaned:
            self.chunks.append(cleaned)


def extract_text(content: str) -> str:
    """Remove scripts/styles and return visible text."""
    content = SCRIPT_RE.sub(" ", content)
    content = STYLE_RE.sub(" ", content)
    parser = TextExtractor()
    parser.feed(content)
    return " ".join(parser.chunks)


def extract_title(content: str, suffix: str) -> str:
    match = TITLE_RE.search(content)
    if match:
        return html.unescape(match.group(1)).strip()
    # Fallback for Markdown
    for line in content.splitlines():
        if line.startswith("#"):
            return line.lstrip("# ").strip()
    return f"(untitled {suffix})"


def scan(root: Path):
    rows = []
    for path in sorted(root.rglob("*")):
        if path.is_file() and path.suffix.lower() in EXTS:
            rel = path.relative_to(root)
            try:
                text = extract_text(path.read_text(encoding="utf-8"))
            except UnicodeDecodeError:
                text = extract_text(path.read_text(errors="ignore"))
            title = extract_title(path.read_text(encoding="utf-8", errors="ignore"), path.name)
            words = len([w for w in re.split(r"\s+", text) if w])
            mtime = datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds")
            thin = words < 250
            rows.append((str(rel).replace(os.sep, "/"), title, words, mtime, thin))
    return rows


def format_report(rows):
    lines = ["PATH | WORDS | THIN? | TITLE | LAST MODIFIED", "-" * 90]
    for rel, title, words, mtime, thin in rows:
        label = "YES" if thin else "NO"
        lines.append(f"{rel} | {words} | {label} | {title} | {mtime}")
    thin_count = sum(1 for r in rows if r[4])
    lines.append("-" * 90)
    lines.append(f"Total files: {len(rows)} — Thin pages: {thin_count}")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Audit visible text on public pages.")
    parser.add_argument("--root", default=".", help="Root directory to scan (default: current).")
    parser.add_argument("--output", help="Optional path to write the report.")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    rows = scan(root)
    report = format_report(rows)
    print(report)

    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(report, encoding="utf-8")
        print(f"\nSaved report to {out_path}")


if __name__ == "__main__":
    main()
