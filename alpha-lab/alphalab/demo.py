"""Synthetic end-to-end run with no network: fake headlines, fake 5m bars, stub model."""

from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

from .db import connect, iso, utcnow
from .news import store_entries
from .predict import StubForecaster, predict_pending
from .prices import BarCache
from .report import load_frame, render
from .resolve import resolve_pending


def synthetic_bars(start: datetime, days: int, seed: int, start_price: float = 100.0) -> pd.DataFrame:
    """Regular-session 5m bars (78/day) for `days` consecutive weekdays from `start`."""
    rng = np.random.default_rng(seed)
    idx = []
    day = start.replace(hour=13, minute=30, second=0, microsecond=0)  # 9:30 ET in UTC during DST
    while len(idx) < days * 78:
        if day.weekday() < 5:
            for i in range(78):
                idx.append(day + timedelta(minutes=5 * i))
        day += timedelta(days=1)
    rets = rng.normal(0, 0.0008, size=len(idx))
    close = start_price * np.exp(np.cumsum(rets))
    open_ = np.concatenate([[start_price], close[:-1]])
    return pd.DataFrame({"Open": open_, "Close": close}, index=pd.DatetimeIndex(idx, tz="UTC"))


def run_demo(db_path=":memory:", n_days: int = 12, seed: int = 7) -> str:
    random.seed(seed)
    conn = connect(db_path)
    now = utcnow()
    start = (now - timedelta(days=n_days + 2)).replace(tzinfo=timezone.utc)
    tickers = ["AAA", "BBB", "CCC"]
    bars = {t: synthetic_bars(start, n_days, seed + i) for i, t in enumerate(tickers)}
    cache = BarCache(fetcher=lambda t: bars[t])

    # Scatter 60 fake headlines across the first half of the window so most horizons can resolve.
    for i in range(60):
        t = random.choice(tickers)
        first = bars[t].index[0].to_pydatetime()
        pub = first + timedelta(minutes=5 * random.randint(0, 78 * (n_days // 2)))
        entry = {"title": f"{t} headline {i}: {random.choice(['beats', 'misses', 'guides', 'announces'])} {random.randint(1, 99)}",
                 "summary": "synthetic", "link": None, "published_at": pub}
        store_entries(conn, t, "synthetic", [entry], now=pub, max_age_min=1e9)
        # Predict at publication time + 3 minutes, exactly as the live loop would.
        predict_pending(conn, StubForecaster(), bars=cache, limit=1, now=pub + timedelta(minutes=3))

    resolve_pending(conn, bars=cache)
    text = render(load_frame(conn))
    print(text)
    return text
