"""Price lookups on 5-minute regular-session bars.

Horizons are defined in *bars*, not wall-clock time, so market closes and
weekends are handled naturally: 1h = 12 bars, 1d = 78 bars (6.5h session),
1w = 390 bars.

Entry is the OPEN of the first bar that starts at or after the prediction
time. Exit is the CLOSE of the bar N bars later. This is the conservative
choice: a prediction logged at 14:32 earns the 14:35 bar's open, never a price
that was already printed when the prediction was made.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Callable

import pandas as pd

log = logging.getLogger(__name__)

HORIZON_BARS = {"1h": 12, "1d": 78, "1w": 390}
HORIZONS = list(HORIZON_BARS)

BarsFetcher = Callable[[str], pd.DataFrame]


def fetch_bars_yfinance(ticker: str) -> pd.DataFrame:
    """Last 60 days of 5m bars (the most yfinance serves at that interval)."""
    import yfinance as yf

    df = yf.Ticker(ticker).history(period="60d", interval="5m", prepost=False, auto_adjust=False)
    return normalise_bars(df)


def normalise_bars(df: pd.DataFrame) -> pd.DataFrame:
    if df is None or df.empty:
        return pd.DataFrame(columns=["Open", "Close"])
    df = df[["Open", "Close"]].copy()
    idx = pd.DatetimeIndex(df.index)
    idx = idx.tz_localize("UTC") if idx.tz is None else idx.tz_convert("UTC")
    df.index = idx
    df = df[~df.index.duplicated(keep="first")].sort_index()
    return df.dropna()


class BarCache:
    """Fetch each ticker at most once per run."""

    def __init__(self, fetcher: BarsFetcher = fetch_bars_yfinance):
        self._fetcher = fetcher
        self._cache: dict[str, pd.DataFrame] = {}

    def get(self, ticker: str) -> pd.DataFrame:
        if ticker not in self._cache:
            try:
                self._cache[ticker] = self._fetcher(ticker)
            except Exception as exc:
                log.warning("price fetch failed for %s: %s", ticker, exc)
                self._cache[ticker] = pd.DataFrame(columns=["Open", "Close"])
        return self._cache[ticker]


def last_price(bars: pd.DataFrame, at: datetime) -> float | None:
    """Close of the most recent bar that started before `at`."""
    if bars.empty:
        return None
    pos = bars.index.searchsorted(pd.Timestamp(at).tz_convert("UTC"), side="right")
    if pos == 0:
        return None
    return float(bars["Close"].iloc[pos - 1])


def resolve_horizon(bars: pd.DataFrame, predicted_at: datetime, horizon: str) -> dict | None:
    """Return the realised trade for a horizon, or None if it is not resolvable yet.

    Result keys: entry_time, entry_price, exit_time, exit_price, return_pct.
    Raises LookupError if the prediction predates the available data window,
    because then the entry price can never be known.
    """
    n = HORIZON_BARS[horizon]
    if bars.empty:
        return None
    ts = pd.Timestamp(predicted_at).tz_convert("UTC")
    if ts < bars.index[0] - pd.Timedelta(minutes=5):
        raise LookupError("prediction predates the price data window")
    entry_idx = int(bars.index.searchsorted(ts, side="left"))
    exit_idx = entry_idx + n
    if exit_idx >= len(bars):
        return None
    entry_price = float(bars["Open"].iloc[entry_idx])
    exit_price = float(bars["Close"].iloc[exit_idx])
    return {
        "entry_time": bars.index[entry_idx].to_pydatetime().astimezone(timezone.utc),
        "entry_price": entry_price,
        "exit_time": bars.index[exit_idx].to_pydatetime().astimezone(timezone.utc),
        "exit_price": exit_price,
        "return_pct": (exit_price / entry_price - 1.0) * 100.0,
    }
