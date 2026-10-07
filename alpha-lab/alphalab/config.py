"""All tunables live here and are overridable with ALPHALAB_* environment variables."""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _env(name: str, default: str) -> str:
    return os.environ.get(f"ALPHALAB_{name}", default)


# Storage
DB_PATH = Path(_env("DB_PATH", str(ROOT / "data" / "alphalab.db")))
TICKERS_FILE = Path(_env("TICKERS_FILE", str(ROOT / "tickers.txt")))

# Ingestion
NEWS_SOURCES = [s.strip() for s in _env("NEWS_SOURCES", "yahoo,google").split(",") if s.strip()]
MAX_ARTICLE_AGE_MIN = float(_env("MAX_ARTICLE_AGE_MIN", "180"))  # older items are stored as skipped
FEED_TIMEOUT_SEC = float(_env("FEED_TIMEOUT_SEC", "15"))
FEED_SLEEP_SEC = float(_env("FEED_SLEEP_SEC", "0.5"))  # politeness delay between feed requests

# Prediction
MODEL = _env("MODEL", "claude-opus-5-5")
EFFORT = _env("EFFORT", "medium")  # low | medium | high | xhigh | max
MAX_PREDICTIONS_PER_CYCLE = int(_env("MAX_PREDICTIONS_PER_CYCLE", "40"))
MAX_STALENESS_MIN = float(_env("MAX_STALENESS_MIN", "240"))  # don't bother predicting on very old news

# Resolution and reporting
COST_BPS_ROUND_TRIP = float(_env("COST_BPS_ROUND_TRIP", "10"))  # 10 bps = 0.10% per round trip
TRADE_THRESHOLD = float(_env("TRADE_THRESHOLD", "0.10"))  # trade only if |p_up - 0.5| >= this
FRESH_STALENESS_MIN = float(_env("FRESH_STALENESS_MIN", "15"))

# Scheduler
CYCLE_MINUTES = float(_env("CYCLE_MINUTES", "5"))

# Approximate USD per million tokens: (input, output, cache_read). Used only for cost logging.
MODEL_PRICES = {
    "claude-opus-5-5": (4.0, 20.0, 0.20),
    "claude-opus-5": (5.0, 25.0, 0.50),
    "claude-sonnet-5-5": (2.0, 10.0, 0.20),
    "claude-sonnet-5": (2.0, 10.0, 0.20),
    "claude-haiku-4-5": (1.0, 5.0, 0.10),
    "claude-fable-5-1": (10.0, 50.0, 0.25),
}
