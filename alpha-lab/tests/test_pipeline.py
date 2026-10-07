"""Offline tests: no network, no API key. Run with  python -m unittest discover -s tests"""

from __future__ import annotations

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pandas as pd  # noqa: E402

from alphalab.db import connect, parse_iso  # noqa: E402
from alphalab.demo import synthetic_bars  # noqa: E402
from alphalab.news import dedupe_key, parse_feed, store_entries  # noqa: E402
from alphalab.predict import Forecast, StubForecaster, predict_pending  # noqa: E402
from alphalab.prices import HORIZON_BARS, BarCache, last_price, resolve_horizon  # noqa: E402
from alphalab.report import load_frame, render, score_horizon  # noqa: E402
from alphalab.resolve import resolve_pending  # noqa: E402

UTC = timezone.utc
START = datetime(2026, 9, 7, tzinfo=UTC)  # a Monday


class PriceResolutionTests(unittest.TestCase):
    def setUp(self):
        self.bars = synthetic_bars(START, days=10, seed=1)

    def test_entry_is_next_bar_open_never_earlier(self):
        # 13:32 UTC falls inside the 13:30 bar; entry must be the 13:35 bar's open.
        pred = self.bars.index[0].to_pydatetime() + timedelta(minutes=2)
        res = resolve_horizon(self.bars, pred, "1h")
        self.assertEqual(res["entry_time"], self.bars.index[1].to_pydatetime())
        self.assertEqual(res["entry_price"], float(self.bars["Open"].iloc[1]))
        self.assertEqual(res["exit_time"], self.bars.index[1 + HORIZON_BARS["1h"]].to_pydatetime())

    def test_exact_bar_start_uses_that_bar(self):
        pred = self.bars.index[5].to_pydatetime()
        res = resolve_horizon(self.bars, pred, "1h")
        self.assertEqual(res["entry_time"], self.bars.index[5].to_pydatetime())

    def test_overnight_prediction_enters_at_next_open(self):
        # 4 hours after the last bar of day 1 is after the close; entry must be day 2's first bar.
        last_day1 = self.bars.index[77].to_pydatetime()
        res = resolve_horizon(self.bars, last_day1 + timedelta(hours=4), "1d")
        self.assertEqual(res["entry_time"], self.bars.index[78].to_pydatetime())
        self.assertEqual(res["exit_time"], self.bars.index[78 + 78].to_pydatetime())

    def test_unresolved_when_horizon_not_elapsed(self):
        pred = self.bars.index[-5].to_pydatetime()
        self.assertIsNone(resolve_horizon(self.bars, pred, "1h"))

    def test_prediction_before_window_raises(self):
        with self.assertRaises(LookupError):
            resolve_horizon(self.bars, START - timedelta(days=3), "1h")

    def test_return_matches_prices(self):
        pred = self.bars.index[10].to_pydatetime()
        res = resolve_horizon(self.bars, pred, "1w")
        expected = (self.bars["Close"].iloc[10 + 390] / self.bars["Open"].iloc[10] - 1) * 100
        self.assertAlmostEqual(res["return_pct"], float(expected))

    def test_last_price_uses_bar_before_timestamp(self):
        at = self.bars.index[3].to_pydatetime() + timedelta(minutes=1)
        self.assertEqual(last_price(self.bars, at), float(self.bars["Close"].iloc[3]))
        self.assertIsNone(last_price(self.bars, START - timedelta(days=1)))


class NewsTests(unittest.TestCase):
    RSS = b"""<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
    <item><title>Acme &amp; Co beats estimates - Reuters</title><link>http://x/1</link>
      <description>&lt;p&gt;Strong quarter&lt;/p&gt;</description>
      <pubDate>Mon, 07 Sep 2026 14:00:00 GMT</pubDate></item>
    <item><title>Old item</title><link>http://x/2</link>
      <pubDate>Mon, 01 Sep 2026 14:00:00 GMT</pubDate></item>
    </channel></rss>"""

    def test_parse_feed_cleans_html_and_parses_dates(self):
        entries = parse_feed(self.RSS)
        self.assertEqual(entries[0]["title"], "Acme & Co beats estimates - Reuters")
        self.assertEqual(entries[0]["summary"], "Strong quarter")
        self.assertEqual(entries[0]["published_at"], datetime(2026, 9, 7, 14, 0, tzinfo=UTC))

    def test_dedupe_ignores_publisher_suffix_and_case(self):
        self.assertEqual(dedupe_key("ACME", "Acme beats estimates - Reuters"), dedupe_key("ACME", "ACME BEATS ESTIMATES"))
        self.assertNotEqual(dedupe_key("ACME", "x"), dedupe_key("OTHER", "x"))

    def test_store_marks_old_as_skipped_and_dedupes(self):
        conn = connect(":memory:")
        now = datetime(2026, 9, 7, 14, 10, tzinfo=UTC)
        fresh, skipped = store_entries(conn, "ACME", "test", parse_feed(self.RSS), now=now, max_age_min=60)
        self.assertEqual((fresh, skipped), (1, 1))
        fresh, skipped = store_entries(conn, "ACME", "test", parse_feed(self.RSS), now=now, max_age_min=60)
        self.assertEqual((fresh, skipped), (0, 0))


class PipelineTests(unittest.TestCase):
    def test_predict_resolve_report_roundtrip(self):
        conn = connect(":memory:")
        bars = synthetic_bars(START, days=10, seed=3)
        cache = BarCache(fetcher=lambda t: bars)
        pub = bars.index[20].to_pydatetime()
        store_entries(conn, "ACME", "test", [{"title": "ACME wins contract", "summary": "", "link": None, "published_at": pub}], now=pub, max_age_min=60)
        store_entries(conn, "ACME", "test", [{"title": "ACME ancient news", "summary": "", "link": None, "published_at": pub - timedelta(days=30)}], now=pub, max_age_min=60)

        stats = predict_pending(conn, StubForecaster(), bars=cache, now=pub + timedelta(minutes=2))
        self.assertEqual(stats["predicted"], 1)
        row = conn.execute("SELECT * FROM predictions").fetchone()
        self.assertAlmostEqual(row["staleness_min"], 2.0)
        self.assertEqual(row["price_at_prediction"], float(bars["Close"].iloc[20]))
        self.assertEqual(conn.execute("SELECT status FROM articles WHERE title LIKE '%ancient%'").fetchone()[0], "skipped")

        rs = resolve_pending(conn, bars=cache)
        self.assertEqual(rs["resolved"], 3)  # 1h, 1d, 1w all fit in 10 days
        df = load_frame(conn)
        self.assertEqual(len(df), 3)
        self.assertTrue(df["return_pct"].notna().all())
        text = render(df)
        self.assertIn("Predictions logged: 1", text)
        for h in ("1h", "1d", "1w"):
            self.assertIn(f"[{h}] n=1", text)

    def test_failing_forecaster_marks_error_and_continues(self):
        class Boom:
            model = "boom"

            def forecast(self, text):
                raise RuntimeError("api down")

        conn = connect(":memory:")
        pub = START + timedelta(hours=15)
        store_entries(conn, "ACME", "test", [{"title": "t", "summary": "", "link": None, "published_at": pub}], now=pub, max_age_min=60)
        stats = predict_pending(conn, Boom(), bars=BarCache(fetcher=lambda t: pd.DataFrame(columns=["Open", "Close"])), now=pub)
        self.assertEqual(stats["errors"], 1)
        self.assertEqual(conn.execute("SELECT status FROM articles").fetchone()[0], "error")


class ScoringTests(unittest.TestCase):
    def test_perfect_and_coin_flip_scores(self):
        rows = []
        for i in range(100):
            ret = 1.0 if i % 2 == 0 else -1.0
            rows.append({"prediction_id": i, "horizon": "1d", "return_pct": ret, "p_up_1d": 0.9 if ret > 0 else 0.1,
                         "staleness_min": 1.0, "actionable": 1, "cost_usd": 0.0})
        df = pd.DataFrame(rows)
        s = score_horizon(df, "1d", threshold=0.1, cost_bps=10)
        self.assertEqual(s["n"], 100)
        self.assertEqual(s["hit_rate"], 1.0)
        self.assertAlmostEqual(s["brier"], 0.01)
        self.assertEqual(s["trades"], 100)
        self.assertAlmostEqual(s["mean_ret_net_pct"], 1.0 - 0.10)
        df["p_up_1d"] = 0.5
        s = score_horizon(df, "1d", threshold=0.1, cost_bps=10)
        self.assertAlmostEqual(s["brier"], 0.25)
        self.assertEqual(s["trades"], 0)

    def test_forecast_clamps_out_of_range(self):
        f = Forecast(p_up_1h=1.4, p_up_1d=-0.2, p_up_1w=0.5, expected_move_1d_pct=0, materiality=2, already_priced=0.5, actionable=False, reasoning="x").clamped()
        self.assertEqual((f.p_up_1h, f.p_up_1d, f.materiality), (1.0, 0.0, 1.0))


if __name__ == "__main__":
    unittest.main()
