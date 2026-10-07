"""SQLite storage. Three tables: articles, predictions, outcomes."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS articles (
    id           INTEGER PRIMARY KEY,
    ticker       TEXT NOT NULL,
    title        TEXT NOT NULL,
    summary      TEXT,
    link         TEXT,
    source       TEXT,
    published_at TEXT,
    fetched_at   TEXT NOT NULL,
    dedupe_key   TEXT NOT NULL UNIQUE,
    status       TEXT NOT NULL DEFAULT 'new'
);
CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status);

CREATE TABLE IF NOT EXISTS predictions (
    id                   INTEGER PRIMARY KEY,
    article_id           INTEGER NOT NULL REFERENCES articles(id),
    ticker               TEXT NOT NULL,
    model                TEXT NOT NULL,
    predicted_at         TEXT NOT NULL,
    staleness_min        REAL,
    price_at_prediction  REAL,
    p_up_1h              REAL NOT NULL,
    p_up_1d              REAL NOT NULL,
    p_up_1w              REAL NOT NULL,
    expected_move_1d_pct REAL,
    materiality          REAL,
    already_priced       REAL,
    actionable           INTEGER,
    reasoning            TEXT,
    raw_json             TEXT,
    input_tokens         INTEGER,
    output_tokens        INTEGER,
    cache_read_tokens    INTEGER,
    cost_usd             REAL
);

CREATE TABLE IF NOT EXISTS outcomes (
    id            INTEGER PRIMARY KEY,
    prediction_id INTEGER NOT NULL REFERENCES predictions(id),
    horizon       TEXT NOT NULL,
    entry_time    TEXT,
    entry_price   REAL,
    exit_time     TEXT,
    exit_price    REAL,
    return_pct    REAL,
    resolved_at   TEXT NOT NULL,
    UNIQUE(prediction_id, horizon)
);
"""


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds")


def parse_iso(s: str) -> datetime:
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def connect(path: Path | str) -> sqlite3.Connection:
    path = Path(path)
    if str(path) != ":memory:":
        path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA)
    return conn


def insert_article(conn: sqlite3.Connection, **row) -> bool:
    """Insert one article. Returns True if it was new, False if the dedupe key already existed."""
    cols = ", ".join(row)
    marks = ", ".join("?" for _ in row)
    cur = conn.execute(
        f"INSERT OR IGNORE INTO articles ({cols}) VALUES ({marks})", tuple(row.values())
    )
    return cur.rowcount == 1


def pending_articles(conn: sqlite3.Connection, limit: int) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM articles WHERE status = 'new' ORDER BY published_at ASC, id ASC LIMIT ?",
        (limit,),
    ).fetchall()


def set_article_status(conn: sqlite3.Connection, article_id: int, status: str) -> None:
    conn.execute("UPDATE articles SET status = ? WHERE id = ?", (status, article_id))


def insert_prediction(conn: sqlite3.Connection, **row) -> int:
    cols = ", ".join(row)
    marks = ", ".join("?" for _ in row)
    cur = conn.execute(f"INSERT INTO predictions ({cols}) VALUES ({marks})", tuple(row.values()))
    return int(cur.lastrowid)


def unresolved(conn: sqlite3.Connection, horizon: str) -> list[sqlite3.Row]:
    """Predictions that have no outcome row for this horizon yet."""
    return conn.execute(
        """
        SELECT p.* FROM predictions p
        LEFT JOIN outcomes o ON o.prediction_id = p.id AND o.horizon = ?
        WHERE o.id IS NULL
        ORDER BY p.predicted_at ASC
        """,
        (horizon,),
    ).fetchall()


def insert_outcome(conn: sqlite3.Connection, **row) -> None:
    cols = ", ".join(row)
    marks = ", ".join("?" for _ in row)
    conn.execute(f"INSERT OR IGNORE INTO outcomes ({cols}) VALUES ({marks})", tuple(row.values()))


def counts(conn: sqlite3.Connection) -> dict[str, int]:
    out = {}
    for status, n in conn.execute("SELECT status, COUNT(*) FROM articles GROUP BY status"):
        out[f"articles_{status}"] = n
    out["predictions"] = conn.execute("SELECT COUNT(*) FROM predictions").fetchone()[0]
    for horizon, n in conn.execute("SELECT horizon, COUNT(*) FROM outcomes GROUP BY horizon"):
        out[f"outcomes_{horizon}"] = n
    return out
