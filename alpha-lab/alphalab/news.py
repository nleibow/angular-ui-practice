"""Headline ingestion from free RSS feeds.

Two sources per ticker by default:
  yahoo  - Yahoo Finance per-ticker headline feed
  google - Google News search feed for "<TICKER> stock"

Every entry is stored once per (ticker, normalised title). Entries older than
MAX_ARTICLE_AGE_MIN are stored with status 'skipped' so they are never
predicted on and never re-fetched.
"""

from __future__ import annotations

import hashlib
import html
import logging
import re
import sqlite3
import time
from calendar import timegm
from datetime import datetime, timezone
from typing import Callable, Iterable

import feedparser
import requests

from . import config
from .db import insert_article, iso, utcnow

log = logging.getLogger(__name__)

USER_AGENT = "alphalab/0.1 (+research prediction logging experiment)"


def yahoo_url(ticker: str) -> str:
    return f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={ticker}&region=US&lang=en-US"


def google_url(ticker: str) -> str:
    return (
        "https://news.google.com/rss/search?"
        f"q={ticker}+stock+when:1d&hl=en-US&gl=US&ceid=US:en"
    )


SOURCE_URLS: dict[str, Callable[[str], str]] = {"yahoo": yahoo_url, "google": google_url}

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def clean_text(s: str | None) -> str:
    if not s:
        return ""
    s = html.unescape(_TAG_RE.sub(" ", s))
    return _WS_RE.sub(" ", s).strip()


def normalise_title(title: str) -> str:
    t = clean_text(title).lower()
    t = re.sub(r"\s+-\s+[^-]+$", "", t)  # strip trailing " - Publisher" that Google appends
    return re.sub(r"[^a-z0-9 ]", "", t)


def dedupe_key(ticker: str, title: str) -> str:
    return hashlib.sha1(f"{ticker}|{normalise_title(title)}".encode()).hexdigest()


def _entry_published(entry) -> datetime | None:
    for attr in ("published_parsed", "updated_parsed"):
        st = getattr(entry, attr, None)
        if st:
            return datetime.fromtimestamp(timegm(st), tz=timezone.utc)
    return None


def parse_feed(raw: bytes) -> list[dict]:
    """Turn raw RSS bytes into plain dicts. Pure function, easy to test."""
    parsed = feedparser.parse(raw)
    out = []
    for e in parsed.entries:
        title = clean_text(getattr(e, "title", ""))
        if not title:
            continue
        out.append(
            {
                "title": title,
                "summary": clean_text(getattr(e, "summary", ""))[:2000],
                "link": getattr(e, "link", None),
                "published_at": _entry_published(e),
            }
        )
    return out


def fetch_feed(url: str, timeout: float) -> list[dict]:
    resp = requests.get(url, timeout=timeout, headers={"User-Agent": USER_AGENT})
    resp.raise_for_status()
    return parse_feed(resp.content)


def store_entries(
    conn: sqlite3.Connection,
    ticker: str,
    source: str,
    entries: Iterable[dict],
    now: datetime | None = None,
    max_age_min: float = config.MAX_ARTICLE_AGE_MIN,
) -> tuple[int, int]:
    """Insert entries; returns (new_fresh, new_skipped)."""
    now = now or utcnow()
    fresh = skipped = 0
    for e in entries:
        pub = e.get("published_at")
        age_min = (now - pub).total_seconds() / 60 if pub else None
        too_old = age_min is None or age_min > max_age_min or age_min < -30
        status = "skipped" if too_old else "new"
        inserted = insert_article(
            conn,
            ticker=ticker,
            title=e["title"],
            summary=e.get("summary") or "",
            link=e.get("link"),
            source=source,
            published_at=iso(pub) if pub else None,
            fetched_at=iso(now),
            dedupe_key=dedupe_key(ticker, e["title"]),
            status=status,
        )
        if inserted:
            if status == "new":
                fresh += 1
            else:
                skipped += 1
    conn.commit()
    return fresh, skipped


def ingest(
    conn: sqlite3.Connection,
    tickers: list[str],
    sources: list[str] | None = None,
    fetcher: Callable[[str, float], list[dict]] = fetch_feed,
) -> dict[str, int]:
    sources = sources or config.NEWS_SOURCES
    totals = {"fresh": 0, "skipped": 0, "errors": 0}
    for ticker in tickers:
        for source in sources:
            url_fn = SOURCE_URLS.get(source)
            if url_fn is None:
                log.warning("unknown news source %r", source)
                continue
            try:
                entries = fetcher(url_fn(ticker), config.FEED_TIMEOUT_SEC)
            except Exception as exc:  # network errors are routine; log and move on
                totals["errors"] += 1
                log.warning("%s/%s fetch failed: %s", ticker, source, exc)
                continue
            fresh, skipped = store_entries(conn, ticker, source, entries)
            totals["fresh"] += fresh
            totals["skipped"] += skipped
            if config.FEED_SLEEP_SEC:
                time.sleep(config.FEED_SLEEP_SEC)
    return totals
