# alpha-lab: does reading the news predict stock moves?

A prediction-logging experiment. Before building any trading system, this
answers the only question that matters: **when a model reads a headline and
says "70% chance this goes up", does it go up 70% of the time, and is there
anything left after costs?**

No trades are placed. No broker is involved. The pipeline logs forecasts the
moment a headline is seen, then waits and scores them against what actually
happened.

## How it works

```
ingest   RSS headlines (Yahoo Finance + Google News) for every ticker in tickers.txt
   |     -> SQLite, deduped, old items marked skipped
predict  each new headline -> Claude -> calibrated p(up) at 1h / 1d / 1w
   |     -> logged with the prediction timestamp and headline age BEFORE any price is known
resolve  once a horizon has elapsed -> 5-minute bars from yfinance -> realised return
   |
report   hit rate, Brier score vs. coin-flip and base-rate, calibration table,
         toy long/short strategy after costs with a t-statistic
```

**Entry and exit are defined conservatively.** Entry is the open of the first
5-minute bar that starts *after* the prediction. Exit is the close N bars later
(1h = 12 bars, 1d = 78, 1w = 390). Bars only exist during the regular session,
so an evening headline is entered at the next open. No look-ahead is possible.

**Staleness is recorded** (minutes between publication and prediction) so you
can test the "fast money already moved" hypothesis directly by comparing the
"fresh" slice of the report to the full set.

## Setup

```bash
cd alpha-lab
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...      # or `ant auth login`
```

Edit `tickers.txt` to set the universe. ~100 liquid large caps are included.

## Run

```bash
# Prove the plumbing works, no network or key needed:
python -m alphalab demo
python -m unittest discover -s tests

# One cycle by hand:
python -m alphalab ingest
python -m alphalab predict          # add --stub to skip the API
python -m alphalab resolve
python -m alphalab report

# Or loop forever (every 5 minutes by default):
python -m alphalab run
```

Leave `run` going during market hours for a few weeks. Run `report` whenever
you like. Resolve must run at least once every 60 days because that is how far
back yfinance serves 5-minute bars; predictions older than that are marked
unresolvable.

## Reading the report

Three slices (all / fresh / model-flagged-actionable) times three horizons.

- **Brier score**: mean squared error of the probability. 0.25 is a coin flip.
  The base-rate Brier is what you get by always answering the historical
  up-rate. The model needs to beat *both* to be carrying information.
- **Calibration row**: "said 0.65, got 0.41" means that when the model said
  65%, it happened 41% of the time. You want these to match.
- **Strategy line**: long if p ≥ 0.5 + threshold, short if p ≤ 0.5 − threshold,
  10 bps round trip (overridable). A |t| above 2 on *net* returns with at
  least a hundred trades is the first thing worth taking seriously. Below that
  it is noise, however good the total looks.

## Knobs

Every setting is an `ALPHALAB_*` environment variable (see `alphalab/config.py`):

| Variable | Default | What it does |
|---|---|---|
| `ALPHALAB_MODEL` | `claude-opus-5-5` | Model used for forecasts |
| `ALPHALAB_EFFORT` | `medium` | Thinking effort (`low` … `max`) |
| `ALPHALAB_MAX_PREDICTIONS_PER_CYCLE` | `40` | Cost cap per loop iteration |
| `ALPHALAB_MAX_STALENESS_MIN` | `240` | Skip headlines older than this |
| `ALPHALAB_COST_BPS_ROUND_TRIP` | `10` | Assumed trading cost in the report |
| `ALPHALAB_TRADE_THRESHOLD` | `0.10` | Min edge over 0.5 to count as a trade |
| `ALPHALAB_CYCLE_MINUTES` | `5` | Loop interval |
| `ALPHALAB_NEWS_SOURCES` | `yahoo,google` | Comma-separated sources |

## Cost

Each forecast is roughly 600 input and 300 output tokens. At Opus 5.5 rates
that is about half a cent per headline. A hundred tickers generate on the order
of 200 to 500 fresh headlines on a normal trading day, so expect roughly
$1 to $3 per day. Spend is logged per prediction and totalled in the report.

## Known limitations

- Free RSS feeds are slow and incomplete. Yahoo's feed can lag the wire by
  minutes to hours. This biases the experiment *against* finding an edge,
  which is the honest direction to be biased in.
- yfinance is unofficial and occasionally returns gaps. Resolution will skip
  and retry on the next cycle.
- The toy strategy ignores borrow costs, slippage beyond the fixed bps, and
  position sizing. It is a signal test, not a backtest.
- Headlines are scored per ticker. A story that mentions two companies becomes
  two separate predictions.

## What to do with the result

If after a few hundred resolved predictions the fresh slice shows Brier below
both baselines and a net t-stat above 2, you have something to investigate:
narrow the universe, look at which sources and headline types carry the
signal, and only then think about execution. If it does not, you have saved
yourself from building a trading system around a signal that does not exist.
