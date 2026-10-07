from __future__ import annotations

from pathlib import Path


def load_tickers(path: Path) -> list[str]:
    tickers: list[str] = []
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        tickers.append(line.upper())
    seen: set[str] = set()
    return [t for t in tickers if not (t in seen or seen.add(t))]
