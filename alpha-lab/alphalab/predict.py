"""Ask a model for calibrated probabilities on a headline and log them.

The model never sees what happened next. The log row is written before any
price for the horizon exists, which is the whole point of the experiment.
"""

from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from pydantic import BaseModel, ConfigDict, Field

from . import config
from .db import insert_prediction, iso, parse_iso, pending_articles, set_article_status, utcnow
from .prices import BarCache, last_price

log = logging.getLogger(__name__)


class Forecast(BaseModel):
    """Structured output schema. Keep descriptions precise: they are the model's instructions."""

    model_config = ConfigDict(extra="forbid")

    p_up_1h: float = Field(
        description="Probability (0 to 1) the stock closes higher one trading hour after this prediction than the next bar's open. 0.5 means no view."
    )
    p_up_1d: float = Field(description="Same, one full trading day (6.5 hours of regular session) ahead.")
    p_up_1w: float = Field(description="Same, five trading days ahead.")
    expected_move_1d_pct: float = Field(
        description="Signed expected one-day return in percent, e.g. -1.5 for an expected 1.5% drop. 0 if no view."
    )
    materiality: float = Field(
        description="0 to 1: how much this news should matter to the stock's fundamentals or near-term flows. Routine coverage is near 0."
    )
    already_priced: float = Field(
        description="0 to 1: probability the market has already fully reacted to this information by the prediction time, given its age and prominence."
    )
    actionable: bool = Field(
        description="True only if you would actually put on a trade on this news alone, after considering that it may already be priced in."
    )
    reasoning: str = Field(description="At most three sentences explaining the numbers.")

    def clamped(self) -> "Forecast":
        c = lambda x: min(1.0, max(0.0, float(x)))  # noqa: E731
        return self.model_copy(
            update={
                "p_up_1h": c(self.p_up_1h),
                "p_up_1d": c(self.p_up_1d),
                "p_up_1w": c(self.p_up_1w),
                "materiality": c(self.materiality),
                "already_priced": c(self.already_priced),
            }
        )


SYSTEM_PROMPT = """You are a sell-side analyst producing calibrated probability forecasts on single news items about US-listed stocks.

You will be scored with the Brier score on whether the stock is higher at each horizon. Calibration matters more than conviction: if you say 0.7, the stock should go up about 70% of the times you say 0.7. Overconfidence is penalised. When the item is routine coverage, old, vague, or very likely already reflected in the price, answer close to 0.5 and mark it not actionable.

Consider explicitly:
- Is this genuinely new information, or commentary on something already public?
- How long ago was it published relative to now? Fast-money traders react in seconds; after minutes, most of the headline move is usually done.
- Is the item about this ticker specifically, or a sector or macro story?
- Does the likely price reaction depend on expectations you cannot see (e.g. whispers before earnings)?

Return only the structured forecast."""


@dataclass
class ModelResult:
    forecast: Forecast
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    raw: dict | None = None


class Forecaster(Protocol):
    def forecast(self, user_text: str) -> ModelResult: ...


def build_user_text(article: sqlite3.Row, now: datetime, price: float | None) -> str:
    published = article["published_at"]
    staleness = None
    if published:
        staleness = (now - parse_iso(published)).total_seconds() / 60
    lines = [
        f"Ticker: {article['ticker']}",
        f"Source: {article['source']}",
        f"Published (UTC): {published or 'unknown'}",
        f"Now (UTC): {iso(now)}",
        f"Minutes since publication: {staleness:.0f}" if staleness is not None else "Minutes since publication: unknown",
        f"Last traded price: {price:.2f}" if price else "Last traded price: unavailable",
        "",
        f"Headline: {article['title']}",
    ]
    if article["summary"]:
        lines += ["", f"Summary: {article['summary']}"]
    return "\n".join(lines)


class ClaudeForecaster:
    """Calls the Claude API with structured output and server-side refusal fallback."""

    def __init__(self, model: str = config.MODEL, effort: str = config.EFFORT):
        import anthropic

        self.client = anthropic.Anthropic()
        self.model = model
        self.effort = effort

    def forecast(self, user_text: str) -> ModelResult:
        resp = self.client.beta.messages.parse(
            model=self.model,
            max_tokens=4000,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_text}],
            output_format=Forecast,
            output_config={"effort": self.effort},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
        if resp.stop_reason == "refusal":
            detail = getattr(resp, "stop_details", None)
            raise RuntimeError(f"model refused: {getattr(detail, 'category', None)}")
        if resp.parsed_output is None:
            raise RuntimeError(f"no parsed output (stop_reason={resp.stop_reason})")
        usage = resp.usage
        return ModelResult(
            forecast=resp.parsed_output.clamped(),
            model=resp.model,
            input_tokens=usage.input_tokens or 0,
            output_tokens=usage.output_tokens or 0,
            cache_read_tokens=getattr(usage, "cache_read_input_tokens", 0) or 0,
            raw=resp.parsed_output.model_dump(),
        )


class StubForecaster:
    """Deterministic pseudo-forecasts for offline tests and demos. Contains no signal."""

    model = "stub"

    def forecast(self, user_text: str) -> ModelResult:
        h = int(hashlib.sha256(user_text.encode()).hexdigest(), 16)
        p = 0.3 + (h % 41) / 100.0  # 0.30 .. 0.70
        f = Forecast(
            p_up_1h=p,
            p_up_1d=p,
            p_up_1w=round(0.5 + (p - 0.5) * 0.5, 3),
            expected_move_1d_pct=round((p - 0.5) * 4, 2),
            materiality=round((h >> 8) % 100 / 100, 2),
            already_priced=round((h >> 16) % 100 / 100, 2),
            actionable=abs(p - 0.5) >= 0.15,
            reasoning="Stub forecast for offline testing.",
        )
        return ModelResult(forecast=f, model=self.model, raw=f.model_dump())


def estimate_cost(model: str, inp: int, out: int, cache_read: int) -> float:
    prices = config.MODEL_PRICES.get(model)
    if not prices:
        return 0.0
    pi, po, pc = prices
    return (inp * pi + out * po + cache_read * pc) / 1_000_000


def predict_pending(
    conn: sqlite3.Connection,
    forecaster: Forecaster,
    bars: BarCache | None = None,
    limit: int = config.MAX_PREDICTIONS_PER_CYCLE,
    now: datetime | None = None,
) -> dict[str, int]:
    """Forecast every 'new' article up to `limit`. Returns counters."""
    bars = bars or BarCache()
    stats = {"predicted": 0, "skipped_stale": 0, "errors": 0, "cost_usd": 0.0}
    for article in pending_articles(conn, limit):
        now_ = now or utcnow()
        staleness = None
        if article["published_at"]:
            staleness = (now_ - parse_iso(article["published_at"])).total_seconds() / 60
            if staleness > config.MAX_STALENESS_MIN:
                set_article_status(conn, article["id"], "skipped")
                conn.commit()
                stats["skipped_stale"] += 1
                continue
        price = last_price(bars.get(article["ticker"]), now_)
        user_text = build_user_text(article, now_, price)
        try:
            result = forecaster.forecast(user_text)
        except Exception as exc:
            stats["errors"] += 1
            log.error("prediction failed for article %s: %s", article["id"], exc)
            set_article_status(conn, article["id"], "error")
            conn.commit()
            continue
        f = result.forecast
        cost = estimate_cost(result.model, result.input_tokens, result.output_tokens, result.cache_read_tokens)
        insert_prediction(
            conn,
            article_id=article["id"],
            ticker=article["ticker"],
            model=result.model,
            predicted_at=iso(now_),
            staleness_min=staleness,
            price_at_prediction=price,
            p_up_1h=f.p_up_1h,
            p_up_1d=f.p_up_1d,
            p_up_1w=f.p_up_1w,
            expected_move_1d_pct=f.expected_move_1d_pct,
            materiality=f.materiality,
            already_priced=f.already_priced,
            actionable=int(f.actionable),
            reasoning=f.reasoning,
            raw_json=json.dumps(result.raw or {}),
            input_tokens=result.input_tokens,
            output_tokens=result.output_tokens,
            cache_read_tokens=result.cache_read_tokens,
            cost_usd=cost,
        )
        set_article_status(conn, article["id"], "predicted")
        conn.commit()
        stats["predicted"] += 1
        stats["cost_usd"] += cost
        log.info(
            "%s %s p1h=%.2f p1d=%.2f p1w=%.2f act=%s | %s",
            article["ticker"], article["id"], f.p_up_1h, f.p_up_1d, f.p_up_1w, f.actionable, article["title"][:80],
        )
    return stats
