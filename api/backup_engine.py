"""
Backup voice engine: Piper, running on the mini PC's own CPU.

Why Piper: the primary voices come from Microsoft Edge's unofficial Read Aloud
endpoint. When it fails, every listener used to drop to a browser voice (no
timestamps, no MP3). This engine has no cloud dependency at all. On this
box (Ryzen 5 2400GE) Piper renders ~5x faster than real time; Kokoro-82M,
the nicer-sounding open model, managed only 0.3-0.7x in three runtimes
(2026-09-25 benchmark), which cannot keep up with playback.

It is used only when Edge fails (see the circuit breaker in tts_server.py)
or when a request asks for it explicitly, so the Edge path and its cache
behave exactly as before.

Import is optional: without the `piper-tts` package or the voice files
(Render, a fresh checkout) `available()` is False and the server simply has
no backup, as before.

Output matches the Edge timed endpoint: MP3 bytes plus [[t_ms, char_offset], ...]
word anchors into the submitted text. Piper gives phoneme/audio alignments,
which we turn into per-word times; if alignments are unavailable the words
are spread evenly across the audio instead.
"""

import os
import re
import threading
import time
from pathlib import Path
from typing import Optional

try:
    from piper import PiperVoice  # noqa: F401
    _IMPORT_OK = True
    _IMPORT_ERR = None
except Exception as _e:  # pragma: no cover - environment dependent
    _IMPORT_OK = False
    _IMPORT_ERR = repr(_e)

MODEL_DIR = Path(os.environ.get("PIPER_MODEL_DIR", "/home/ubuntu/tts_models/piper"))
MP3_KBPS = 64

# Edge voice id -> Piper voice name (files: <name>.onnx + <name>.onnx.json in
# MODEL_DIR). Piper has no Japanese or Korean voices, so those Edge voices
# have no backup and fail as before.
VOICE_MAP = {
    "en-US-AriaNeural":      "en_US-lessac-medium",
    "en-US-GuyNeural":       "en_US-ryan-medium",
    "en-GB-SoniaNeural":     "en_GB-alba-medium",
    "es-MX-DaliaNeural":     "es_MX-claude-high",
    "es-ES-AlvaroNeural":    "es_ES-davefx-medium",
    "fr-FR-DeniseNeural":    "fr_FR-siwis-medium",
    "fr-FR-HenriNeural":     "fr_FR-tom-medium",
    "de-DE-KatjaNeural":     "de_DE-kerstin-low",
    "de-DE-ConradNeural":    "de_DE-thorsten-medium",
    "it-IT-ElsaNeural":      "it_IT-paola-medium",
    "it-IT-DiegoNeural":     "it_IT-riccardo-x_low",
    "pt-BR-FranciscaNeural": "pt_BR-faber-medium",
    "pt-BR-AntonioNeural":   "pt_BR-faber-medium",
    "zh-CN-XiaoxiaoNeural":  "zh_CN-huayan-medium",
    "zh-CN-YunxiNeural":     "zh_CN-huayan-medium",
}

_voices: dict = {}
_load_lock = threading.Lock()
# Serialize synthesis: the CPU is shared with everything else on the box, and
# two renders at once just make both late.
_synth_lock = threading.Lock()
_last_error: Optional[str] = None
_alignments_ok: Optional[bool] = None


def _model_path(name: str) -> Path:
    return MODEL_DIR / f"{name}.onnx"


def available() -> bool:
    return _IMPORT_OK and MODEL_DIR.is_dir()


def supports(voice: str) -> bool:
    name = VOICE_MAP.get(voice)
    return bool(available() and name and _model_path(name).is_file())


def status() -> dict:
    present = sorted(v for v, n in VOICE_MAP.items() if _model_path(n).is_file()) if MODEL_DIR.is_dir() else []
    return {
        "engine": "piper",
        "available": available(),
        "import_error": _IMPORT_ERR,
        "model_dir": str(MODEL_DIR),
        "voices_ready": present,
        "loaded": sorted(_voices.keys()),
        "alignments": _alignments_ok,
        "last_error": _last_error,
    }


def _voice(name: str):
    v = _voices.get(name)
    if v is not None:
        return v
    with _load_lock:
        v = _voices.get(name)
        if v is None:
            from piper import PiperVoice
            # include_alignments patches the model in memory (needs the `onnx`
            # package); if that isn't possible Piper still loads, minus timings.
            try:
                v = PiperVoice.load(str(_model_path(name)), include_alignments=True)
            except Exception:
                v = PiperVoice.load(str(_model_path(name)))
            _voices[name] = v
    return v


def warm(voice: str = "en-US-AriaNeural") -> None:
    """Load the default English voice so the first fallback answers quickly."""
    global _last_error
    if supports(voice):
        try:
            _voice(VOICE_MAP[voice])
        except Exception as e:  # pragma: no cover
            _last_error = f"warm: {e!r}"


def _encode_mp3(samples, sample_rate: int) -> bytes:
    """float mono -> MP3 bytes (lameenc: self-contained LAME wheel)."""
    import lameenc
    import numpy as np
    pcm = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    pcm16 = (pcm * 32767.0).astype("<i2").tobytes()
    enc = lameenc.Encoder()
    enc.set_bit_rate(MP3_KBPS)
    enc.set_in_sample_rate(int(sample_rate))
    enc.set_channels(1)
    enc.set_quality(5)
    enc.silence()
    return bytes(enc.encode(pcm16)) + bytes(enc.flush())


def _word_starts_from_alignments(alignments, sample_rate: int) -> list:
    """Start time (ms) of each spoken word from phoneme alignments; a space
    phoneme is Piper's word separator."""
    starts, pos, at_word_start = [], 0, True
    for al in alignments:
        ph = getattr(al, "phoneme", "")
        n = int(getattr(al, "num_samples", 0) or 0)
        if ph.isspace():
            at_word_start = True
        elif at_word_start and ph not in ("^", "$", "_"):  # BOS/EOS/pad markers
            starts.append(int(pos * 1000 / sample_rate))
            at_word_start = False
        pos += n
    return starts


def synthesize(text: str, voice: str, speed: float = 1.0) -> dict:
    """Synthesize `text` with the Piper voice mapped from an Edge voice id.

    Returns {"audio": mp3_bytes, "words": [[t_ms, char_offset], ...],
             "duration_ms": int, "synth_ms": int, "voice": piper_voice}.
    Raises on any failure; the caller decides how to report it.
    """
    global _last_error, _alignments_ok
    if not _IMPORT_OK:
        raise RuntimeError(f"piper not importable: {_IMPORT_ERR}")
    if not supports(voice):
        raise ValueError(f"no backup voice for {voice}")
    name = VOICE_MAP[voice]

    import numpy as np
    t_start = time.time()
    try:
        v = _voice(name)
        text_words = [m.start() for m in re.finditer(r"\S+", text)]
        chunks, starts = [], []
        pos_samples = 0
        sample_rate = None
        with _synth_lock:
            for chunk in v.synthesize(text, include_alignments=True):
                sr = int(chunk.sample_rate)
                sample_rate = sample_rate or sr
                samples = np.asarray(chunk.audio_float_array, dtype=np.float32)
                al = getattr(chunk, "phoneme_alignments", None)
                if al:
                    base_ms = int(pos_samples * 1000 / sr)
                    starts.extend(base_ms + t for t in _word_starts_from_alignments(al, sr))
                chunks.append(samples)
                pos_samples += len(samples)
        if not chunks or not sample_rate:
            raise RuntimeError("piper produced no audio")
        pcm = np.concatenate(chunks)
        duration_ms = int(len(pcm) * 1000 / sample_rate)

        _alignments_ok = bool(starts)
        if starts and abs(len(starts) - len(text_words)) <= max(2, len(text_words) // 5):
            # Spoken words line up with text words closely enough: pair them in order.
            n = min(len(starts), len(text_words))
            words = [[starts[i], text_words[i]] for i in range(n)]
        else:
            # No alignments (or espeak split words differently): spread the
            # text's words across the audio in proportion to their length.
            total = sum(len(w) for w in re.findall(r"\S+", text)) or 1
            words, acc = [], 0
            for m in re.finditer(r"\S+", text):
                words.append([int(duration_ms * acc / total), m.start()])
                acc += len(m.group())

        return {
            "audio": _encode_mp3(pcm, sample_rate),
            "words": words,
            "duration_ms": duration_ms,
            "synth_ms": int((time.time() - t_start) * 1000),
            "voice": name,
        }
    except Exception as e:
        _last_error = f"{type(e).__name__}: {e}"
        raise


if __name__ == "__main__":  # quick local benchmark: python -m api.backup_engine [edge-voice-id]
    import sys
    sample = ("The quick brown fox jumps over the lazy dog. Numbers like 42 and Dr. Smith are normalized. " * 12).strip()
    vid = sys.argv[1] if len(sys.argv) > 1 else "en-US-AriaNeural"
    t0 = time.time(); warm(vid); print(f"load {time.time() - t0:.1f}s  alignments={_alignments_ok}")
    r = synthesize(sample, vid)
    print(f"chars {len(sample)} audio {r['duration_ms'] / 1000:.1f}s synth {r['synth_ms'] / 1000:.1f}s "
          f"-> {r['duration_ms'] / max(1, r['synth_ms']):.1f}x realtime, mp3 {len(r['audio']) // 1024} KB, "
          f"anchors {len(r['words'])} (text words {len(sample.split())}) first {r['words'][:3]} alignments={_alignments_ok}")
    open("/tmp/piper_bench.mp3", "wb").write(r["audio"])
