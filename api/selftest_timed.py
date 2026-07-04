#!/usr/bin/env python3
"""Self-test for the /api/tts/timed word-timing pipeline.

Run from the api/ directory (or repo root) inside the venv:

    python api/selftest_timed.py          # unit checks only (no network)
    python api/selftest_timed.py --live   # + real Edge TTS synthesis round-trip

No pytest dependency on purpose — this repo has no test infra and the API
requirements stay untouched.
"""

import asyncio
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0].rsplit("\\", 1)[0])

from tts_server import TICKS_PER_MS, _map_word_offsets


def t(ms):
    return ms * TICKS_PER_MS


def check(name, cond, detail=""):
    status = "ok  " if cond else "FAIL"
    print(f"  [{status}] {name}" + (f" — {detail}" if detail and not cond else ""))
    return cond


def unit_checks():
    print("Unit checks: _map_word_offsets")
    ok = True

    # Plain sentence: every word maps, offsets are the char positions.
    text = "The quick brown fox jumps."
    b = [(t(0), t(200), "The"), (t(250), t(200), "quick"), (t(500), t(200), "brown"),
         (t(750), t(200), "fox"), (t(1000), t(300), "jumps")]
    words = _map_word_offsets(text, b)
    ok &= check("plain sentence maps all words", len(words) == 5, str(words))
    ok &= check("char offsets correct", [w[1] for w in words] == [0, 4, 10, 16, 20], str(words))
    ok &= check("times in ms", [w[0] for w in words] == [0, 250, 500, 750, 1000], str(words))

    # Repeated words advance the cursor, not re-match the first occurrence.
    text = "go go go"
    b = [(t(0), t(100), "go"), (t(200), t(100), "go"), (t(400), t(100), "go")]
    words = _map_word_offsets(text, b)
    ok &= check("repeated words advance", [w[1] for w in words] == [0, 3, 6], str(words))

    # Normalized token ("2026" spoken as words) is skipped, following words recover.
    text = "In 2026 we shipped it."
    b = [(t(0), t(100), "In"), (t(150), t(300), "twenty"), (t(450), t(300), "twenty-six"),
         (t(800), t(100), "we"), (t(950), t(200), "shipped"), (t(1200), t(100), "it")]
    words = _map_word_offsets(text, b)
    ok &= check("normalized number skipped", [w[1] for w in words] == [0, 8, 11, 19], str(words))

    # A skipped token must not false-match far ahead (window guard).
    text = "Price: 100. " + "x" * 300 + " one more thing"
    b = [(t(0), t(100), "Price"), (t(200), t(300), "one hundred"), (t(600), t(100), "one")]
    words = _map_word_offsets(text, b)
    # "one hundred" isn't in the text; bare "one" appears 300+ chars ahead — outside
    # the window from cursor (after "Price"), so it must be skipped too.
    ok &= check("window guard blocks far match", [w[1] for w in words] == [0], str(words))

    # Case-insensitive match.
    text = "HELLO world"
    b = [(t(0), t(100), "hello"), (t(200), t(100), "World")]
    words = _map_word_offsets(text, b)
    ok &= check("case-insensitive", [w[1] for w in words] == [0, 6], str(words))

    # CJK: boundary text is a substring of the source (no spaces).
    text = "今日は良い天気です。"
    b = [(t(0), t(300), "今日は"), (t(300), t(300), "良い"), (t(600), t(300), "天気です")]
    words = _map_word_offsets(text, b)
    ok &= check("CJK substrings map", [w[1] for w in words] == [0, 3, 5], str(words))

    # Monotonic char offsets guaranteed by cursor advance.
    ok &= check("offsets monotonic", all(a[1] < b_[1] for a, b_ in zip(words, words[1:])))
    return ok


async def live_check():
    import edge_tts
    print("Live check: real Edge TTS synthesis with word boundaries")
    text = ("Read-Aloud converts text to natural speech. "
            "In 2026 the reader got word-accurate highlighting, "
            "so every spoken word lights up exactly on time.")
    communicate = edge_tts.Communicate(text=text, voice="en-US-AriaNeural",
                                       boundary="WordBoundary")
    audio = bytearray()
    boundaries = []
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio.extend(chunk["data"])
        elif chunk["type"] == "WordBoundary":
            boundaries.append((chunk.get("offset", 0), chunk.get("duration", 0),
                               chunk.get("text", "")))

    ok = True
    ok &= check("audio produced", len(audio) > 10_000, f"{len(audio)} bytes")
    ok &= check("boundaries emitted", len(boundaries) >= 20, f"{len(boundaries)} boundaries")
    offs = [b[0] for b in boundaries]
    ok &= check("boundary times monotonic", all(a <= b_ for a, b_ in zip(offs, offs[1:])))

    words = _map_word_offsets(text, boundaries)
    ok &= check("most words mapped", len(words) >= 0.8 * len(boundaries),
                f"{len(words)}/{len(boundaries)} mapped")
    chars = [w[1] for w in words]
    ok &= check("mapped offsets monotonic", all(a < b_ for a, b_ in zip(chars, chars[1:])))
    ok &= check("first word at char 0", bool(words) and words[0][1] == 0, str(words[:3]))
    last_ms = words[-1][0] if words else 0
    ok &= check("duration sane (5-20s)", 5_000 < last_ms < 20_000, f"last anchor {last_ms}ms")

    print("  sample anchors:", [(w[0], text[w[1]:w[1] + 8]) for w in words[:6]])
    return ok


if __name__ == "__main__":
    passed = unit_checks()
    if "--live" in sys.argv:
        passed = asyncio.run(live_check()) and passed
    print("PASS" if passed else "FAIL")
    sys.exit(0 if passed else 1)
