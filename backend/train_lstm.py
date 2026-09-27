"""Optional per-region next-day forecast using TensorFlow/Keras.

Run: python -m backend.train_lstm --bbox -130 20 -60 55
This creates a local JSON forecast only when sufficient historical data exists.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import date

from .app.core import ROOT, connect, summarize


def artifact_path(bbox):
    digest = hashlib.sha256(",".join(f"{x:g}" for x in bbox).encode()).hexdigest()[:16]
    return ROOT / "data" / f"forecast-{digest}.json"


def fit_lstm(values, epochs=50):
    """Fit a chronological holdout model and return (prediction, MAE, holdout days)."""
    if len(values) < 60 or sum(v > 0 for v in values) < 20:
        raise RuntimeError("At least 60 consecutive covered days and 20 active days are required for LSTM training")
    try:
        import numpy as np
        import tensorflow as tf
    except ImportError as exc:
        raise RuntimeError("Install backend/requirements-ml.txt with Python 3.11–3.13 to train the LSTM") from exc
    tf.keras.utils.set_random_seed(19)
    window = 14
    samples = len(values) - window
    split = max(1, int(samples * .8))
    if samples - split < 7:
        raise RuntimeError("Not enough holdout days to evaluate the model")
    # Fit scaling on the training interval only; keep the holdout days unseen.
    scale = max(1.0, max(values[:window + split]))
    x = np.asarray([[v / scale for v in values[i:i + window]] for i in range(samples)], dtype=np.float32)[..., np.newaxis]
    y = np.asarray([v / scale for v in values[window:]], dtype=np.float32)

    model = tf.keras.Sequential([
        tf.keras.layers.Input(shape=(window, 1)),
        tf.keras.layers.LSTM(24),
        tf.keras.layers.Dense(1),
    ])
    model.compile(optimizer=tf.keras.optimizers.Adam(learning_rate=.008), loss="mse")
    model.fit(x[:split], y[:split], epochs=epochs, batch_size=16, shuffle=False, verbose=0)
    holdout = model.predict(x[split:], verbose=0).reshape(-1) * scale
    mae = float(np.mean(np.abs(holdout - y[split:] * scale)))
    next_window = np.asarray(values[-window:], dtype=np.float32).reshape(1, window, 1) / scale
    prediction = max(0.0, float(model.predict(next_window, verbose=0)[0, 0]) * scale)
    return prediction, mae, len(holdout)


def train(bbox, epochs=50):
    area = ",".join(f"{v:g}" for v in bbox)
    with connect() as db:
        bounds = db.execute("SELECT MIN(day), MAX(day) FROM ingestions WHERE bbox = ?", (area,)).fetchone()
    if bounds[0] is None:
        raise RuntimeError("No complete-region ingestions are stored for this region")
    series = summarize(bbox, date.fromisoformat(bounds[0]), date.fromisoformat(bounds[1]))["series"]
    # Never interpret days that were not fetched as zero fire activity.
    last_gap = max((i for i, row in enumerate(series) if row["covered_sources"] < 2), default=-1)
    series = series[last_gap + 1:]
    values = [float(row["occupied_cells"]) for row in series]
    prediction, mae, holdout_days = fit_lstm(values, epochs)
    result = {"model": "tensorflow_lstm", "bbox": bbox, "trained_through": series[-1]["day"],
              "forecast_next_day_cells": round(prediction, 1), "holdout_mae_cells": round(mae, 1),
              "training_days": len(values), "holdout_days": holdout_days,
              "note": "Experimental next-day occupied-cell forecast; not a fire probability."}
    path = artifact_path(bbox)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bbox", nargs=4, type=float, required=True, metavar=("WEST", "SOUTH", "EAST", "NORTH"))
    parser.add_argument("--epochs", type=int, default=50)
    args = parser.parse_args()
    print(json.dumps(train(args.bbox, args.epochs), indent=2))
