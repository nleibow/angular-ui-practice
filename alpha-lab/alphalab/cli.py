"""Command-line entry point.  python -m alphalab <command>"""

from __future__ import annotations

import argparse
import logging
import sys
import time

from . import config
from .db import connect, counts
from .universe import load_tickers

log = logging.getLogger("alphalab")


def _conn():
    return connect(config.DB_PATH)


def cmd_ingest(args):
    from .news import ingest

    conn = _conn()
    tickers = load_tickers(config.TICKERS_FILE)
    stats = ingest(conn, tickers)
    print("ingest:", stats)


def cmd_predict(args):
    from .predict import ClaudeForecaster, StubForecaster, predict_pending

    conn = _conn()
    forecaster = StubForecaster() if args.stub else ClaudeForecaster()
    stats = predict_pending(conn, forecaster, limit=args.limit or config.MAX_PREDICTIONS_PER_CYCLE)
    print("predict:", stats)


def cmd_resolve(args):
    from .resolve import resolve_pending

    conn = _conn()
    print("resolve:", resolve_pending(conn))


def cmd_report(args):
    from .report import load_frame, render

    conn = _conn()
    df = load_frame(conn)
    print(render(df, threshold=args.threshold, cost_bps=args.cost_bps))
    if args.csv:
        df.to_csv(args.csv, index=False)
        print(f"wrote {args.csv}")


def cmd_status(args):
    print(counts(_conn()))


def cmd_run(args):
    """ingest -> predict -> resolve, forever, every CYCLE_MINUTES."""
    from .news import ingest
    from .predict import ClaudeForecaster, StubForecaster, predict_pending
    from .prices import BarCache
    from .resolve import resolve_pending

    conn = _conn()
    tickers = load_tickers(config.TICKERS_FILE)
    forecaster = StubForecaster() if args.stub else ClaudeForecaster()
    cycle = (args.minutes or config.CYCLE_MINUTES) * 60
    log.info("running every %.0fs on %d tickers with model %s", cycle, len(tickers), forecaster.model)
    while True:
        started = time.time()
        try:
            bars = BarCache()  # fresh price cache per cycle
            log.info("ingest: %s", ingest(conn, tickers))
            log.info("predict: %s", predict_pending(conn, forecaster, bars=bars))
            log.info("resolve: %s", resolve_pending(conn, bars=bars))
            log.info("status: %s", counts(conn))
        except KeyboardInterrupt:
            raise
        except Exception:
            log.exception("cycle failed; continuing")
        time.sleep(max(0.0, cycle - (time.time() - started)))


def cmd_demo(args):
    """Offline end-to-end run on synthetic news and prices. Proves the plumbing, not the alpha."""
    from .demo import run_demo

    run_demo()


def main(argv=None):
    p = argparse.ArgumentParser(prog="alphalab", description=__doc__)
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("ingest", help="fetch headlines for the ticker universe").set_defaults(fn=cmd_ingest)

    sp = sub.add_parser("predict", help="forecast on new headlines")
    sp.add_argument("--limit", type=int)
    sp.add_argument("--stub", action="store_true", help="use the no-signal stub instead of the API")
    sp.set_defaults(fn=cmd_predict)

    sub.add_parser("resolve", help="fill in outcomes for elapsed horizons").set_defaults(fn=cmd_resolve)

    sp = sub.add_parser("report", help="calibration and return report")
    sp.add_argument("--threshold", type=float, default=config.TRADE_THRESHOLD)
    sp.add_argument("--cost-bps", type=float, default=config.COST_BPS_ROUND_TRIP)
    sp.add_argument("--csv", help="also dump the merged table to this path")
    sp.set_defaults(fn=cmd_report)

    sub.add_parser("status", help="row counts").set_defaults(fn=cmd_status)

    sp = sub.add_parser("run", help="loop ingest/predict/resolve forever")
    sp.add_argument("--minutes", type=float)
    sp.add_argument("--stub", action="store_true")
    sp.set_defaults(fn=cmd_run)

    sub.add_parser("demo", help="offline synthetic end-to-end run").set_defaults(fn=cmd_demo)

    args = p.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    args.fn(args)


if __name__ == "__main__":
    main()
