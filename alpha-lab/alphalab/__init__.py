"""alphalab: a prediction-logging experiment for news-driven stock forecasts.

The pipeline is deliberately split into four stages so that each one can be
audited on its own:

    ingest  -> pull headlines for a ticker universe into SQLite
    predict -> ask a model for calibrated probabilities, log them BEFORE prices are known
    resolve -> once the horizon has elapsed, look up what actually happened
    report  -> calibration, Brier score, and after-cost returns per horizon
"""

__version__ = "0.1.0"
