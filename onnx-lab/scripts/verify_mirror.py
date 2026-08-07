"""
Is the mirror byte-identical to what the app expects?

The STT downloader hard-fails on a sha256 mismatch — deliberately: an
earlier version produced a file of exactly the right SIZE with the wrong
BYTES, and a corrupt 225 MB ONNX takes the recogniser process down with a
C++ exception and no message. Those hashes are compiled into the app, so
if a mirror differs by one byte the model stops installing.

This compares the hashes the Hub publishes for the mirror against the ones
in src/main/stt/catalog.ts, read straight out of the TypeScript rather
than copied here — a copy would prove only that two copies agree.

    HF_TOKEN=... python scripts/verify_mirror.py
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from huggingface_hub import HfApi

STT_CATALOG = Path("../desktop/src/main/stt/catalog.ts")
TTS_CATALOG = Path("../desktop/src/main/tts/catalog.ts")


def scan(text: str, repo: str = "") -> dict[str, dict[str, str]]:
    """{repo: {path: sha256}} from a catalogue's source.

    Read out of the TypeScript rather than copied here: a copy would prove
    only that two copies agree. The STT catalogue names a repo per model;
    the TTS one has a single TTS_REPO for the whole file, passed in.
    """
    out: dict[str, dict[str, str]] = {}
    if repo:
        out[repo] = {}
    path = ""
    for line in text.splitlines():
        found = re.search(r'(?:repo|TTS_REPO =)\s*[:=]?\s*"([^"]+)"', line)
        if found:
            repo = found.group(1)
            out.setdefault(repo, {})
            continue
        found = re.search(r'path:\s*"([^"]+)"', line)
        if found:
            path = found.group(1)
            continue
        found = re.search(r'sha256:\s*"([0-9a-f]{64})"', line)
        if found and repo and path:
            out[repo][path] = found.group(1)
    return out


def expected() -> dict[str, dict[str, str]]:
    both = scan(STT_CATALOG.read_text(encoding="utf-8"))
    both.update(scan(TTS_CATALOG.read_text(encoding="utf-8")))
    return both


def main() -> None:
    token = os.environ.get("HF_TOKEN")
    if not token:
        raise SystemExit("HF_TOKEN is not set in the environment")
    hub = HfApi(token=token)

    failures = 0
    for repo, files in expected().items():
        if not files:
            continue
        print(f"\n{repo}")
        try:
            info = hub.model_info(repo, files_metadata=True)
        except Exception as err:
            print(f"  UNREACHABLE  {type(err).__name__}")
            failures += 1
            continue
        published = {
            s.rfilename: (s.lfs.get("sha256") if isinstance(s.lfs, dict) else getattr(s.lfs, "sha256", None))
            for s in info.siblings
        }
        for path, want in files.items():
            got = published.get(path)
            if got == want:
                print(f"  ok    {path}")
            else:
                failures += 1
                print(f"  WRONG {path}\n        want {want}\n        got  {got}")

    print("\n" + ("MIRROR MATCHES THE CATALOGUE" if not failures else f"{failures} MISMATCHED"))
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
