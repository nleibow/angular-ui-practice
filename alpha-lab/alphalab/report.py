"""Scoring. Answers one question per horizon: does the model know anything?

Three lenses:
  1. Direction accuracy vs. a coin flip.
  2. Calibration: when it says 70%, does it happen 70% of the time? Plus Brier
     score against the two cheapest baselines (always 0.5, and the base rate).
  3. A toy strategy: go long when p_up >= 0.5 + threshold, short when
     p_up <= 0.5 - threshold, pay a round-trip cost, look at mean return and a
     t-statistic.

Each lens is run on three slices: all predictions, fresh ones (low staleness),
and ones the model itself flagged as actionable.
"""

from __future__ import annotations

import math
import sqlite3

import pandas as pd

from . import config

BUCKETS = [0.0, 0.2, 0.4, 0.6, 0.8, 1.0001]


def load_frame(conn: sqlite3.Connection) -> pd.DataFrame:
    q = """
    SELECT p.id AS prediction_id, p.ticker, p.model, p.predicted_at, p.staleness_min,
           p.p_up_1h, p.p_up_1d, p.p_up_1w, p.expected_move_1d_pct, p.materiality,
           p.already_priced, p.actionable, p.cost_usd, a.title, a.source,
           o.horizon, o.entry_time, o.entry_price, o.exit_time, o.exit_price, o.return_pct
    FROM predictions p
    JOIN articles a ON a.id = p.article_id
    LEFT JOIN outcomes o ON o.prediction_id = p.id
    """
    return pd.read_sql_query(q, conn)


def _tstat(x: pd.Series) -> float:
    n = len(x)
    if n < 2 or x.std(ddof=1) == 0:
        return float("nan")
    return float(x.mean() / (x.std(ddof=1) / math.sqrt(n)))


def score_horizon(df: pd.DataFrame, horizon: str, threshold: float, cost_bps: float) -> dict:
    d = df[(df["horizon"] == horizon) & df["return_pct"].notna()].copy()
    out: dict = {"horizon": horizon, "n": int(len(d))}
    if d.empty:
        return out
    p = d[f"p_up_{horizon}"].astype(float)
    y = (d["return_pct"] > 0).astype(float)
    nonzero = d["return_pct"] != 0

    out["hit_rate"] = float(((p > 0.5) == (d["return_pct"] > 0))[nonzero].mean()) if nonzero.any() else float("nan")
    out["base_rate_up"] = float(y.mean())
    out["brier"] = float(((p - y) ** 2).mean())
    out["brier_coin"] = 0.25
    out["brier_base_rate"] = float(((y.mean() - y) ** 2).mean())

    cal = []
    for lo, hi in zip(BUCKETS[:-1], BUCKETS[1:]):
        m = (p >= lo) & (p < hi)
        if m.any():
            cal.append({"bucket": f"{lo:.1f}-{min(hi,1):.1f}", "n": int(m.sum()), "mean_p": float(p[m].mean()), "realised_up": float(y[m].mean())})
    out["calibration"] = cal

    pos = pd.Series(0.0, index=d.index)
    pos[p >= 0.5 + threshold] = 1.0
    pos[p <= 0.5 - threshold] = -1.0
    traded = pos != 0
    pnl = pos * d["return_pct"] - traded * (cost_bps / 100.0)
    t = pnl[traded]
    out["trades"] = int(traded.sum())
    if traded.any():
        out["trade_hit_rate"] = float(((pos * d["return_pct"])[traded] > 0).mean())
        out["mean_ret_gross_pct"] = float((pos * d["return_pct"])[traded].mean())
        out["mean_ret_net_pct"] = float(t.mean())
        out["total_ret_net_pct"] = float(t.sum())
        out["tstat_net"] = _tstat(t)
    return out


def slices(df: pd.DataFrame) -> dict[str, pd.DataFrame]:
    return {
        "all": df,
        f"fresh (<= {config.FRESH_STALENESS_MIN:.0f} min old)": df[df["staleness_min"].fillna(1e9) <= config.FRESH_STALENESS_MIN],
        "model-flagged actionable": df[df["actionable"] == 1],
    }


def _fmt(v, nd=3):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return "  n/a"
    return f"{v:.{nd}f}"


def render(df: pd.DataFrame, threshold: float = config.TRADE_THRESHOLD, cost_bps: float = config.COST_BPS_ROUND_TRIP) -> str:
    lines = []
    n_pred = df["prediction_id"].nunique()
    cost = df.drop_duplicates("prediction_id")["cost_usd"].fillna(0).sum()
    lines.append(f"Predictions logged: {n_pred}   API spend: ${cost:.2f}   "
                 f"trade threshold: |p-0.5| >= {threshold:.2f}   cost: {cost_bps:.0f} bps round trip")
    if n_pred == 0:
        return "\n".join(lines)
    for name, sl in slices(df).items():
        lines.append("")
        lines.append(f"=== slice: {name} ({sl['prediction_id'].nunique()} predictions) ===")
        for h in ("1h", "1d", "1w"):
            s = score_horizon(sl, h, threshold, cost_bps)
            if s["n"] == 0:
                lines.append(f"  [{h}] no resolved outcomes yet")
                continue
            lines.append(
                f"  [{h}] n={s['n']}  hit={_fmt(s['hit_rate'])} (base up-rate {_fmt(s['base_rate_up'])})  "
                f"brier={_fmt(s['brier'])} vs coin 0.250 / base-rate {_fmt(s['brier_base_rate'])}"
            )
            if s.get("trades"):
                lines.append(
                    f"       trades={s['trades']}  hit={_fmt(s['trade_hit_rate'])}  "
                    f"mean gross={_fmt(s['mean_ret_gross_pct'])}%  mean net={_fmt(s['mean_ret_net_pct'])}%  "
                    f"total net={_fmt(s['total_ret_net_pct'],2)}%  t={_fmt(s['tstat_net'],2)}"
                )
            else:
                lines.append("       trades=0")
            cal = "  ".join(f"{c['bucket']}: n={c['n']} said {c['mean_p']:.2f} got {c['realised_up']:.2f}" for c in s["calibration"])
            lines.append(f"       calibration: {cal}")
    lines.append("")
    lines.append("How to read: brier below 0.25 and below base-rate means real information. "
                 "A |t| above ~2 on net returns with 100+ trades is the first sign of an edge; below that is noise.")
    return "\n".join(lines)
