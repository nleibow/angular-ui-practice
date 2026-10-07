"""Fill in outcomes for predictions whose horizon has elapsed."""

from __future__ import annotations

import logging
import sqlite3

from .db import insert_outcome, iso, parse_iso, unresolved, utcnow
from .prices import HORIZONS, BarCache, resolve_horizon

log = logging.getLogger(__name__)


def resolve_pending(conn: sqlite3.Connection, bars: BarCache | None = None) -> dict[str, int]:
    bars = bars or BarCache()
    stats = {"resolved": 0, "pending": 0, "unresolvable": 0}
    for horizon in HORIZONS:
        for pred in unresolved(conn, horizon):
            frame = bars.get(pred["ticker"])
            try:
                res = resolve_horizon(frame, parse_iso(pred["predicted_at"]), horizon)
            except LookupError as exc:
                # Data window has moved past this prediction; record a null outcome so we stop retrying.
                log.warning("prediction %s/%s unresolvable: %s", pred["id"], horizon, exc)
                insert_outcome(conn, prediction_id=pred["id"], horizon=horizon, resolved_at=iso(utcnow()))
                stats["unresolvable"] += 1
                continue
            if res is None:
                stats["pending"] += 1
                continue
            insert_outcome(
                conn,
                prediction_id=pred["id"],
                horizon=horizon,
                entry_time=iso(res["entry_time"]),
                entry_price=res["entry_price"],
                exit_time=iso(res["exit_time"]),
                exit_price=res["exit_price"],
                return_pct=res["return_pct"],
                resolved_at=iso(utcnow()),
            )
            stats["resolved"] += 1
        conn.commit()
    return stats
