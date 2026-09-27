"""Optional per-region next-day forecast. Requires: pip install torch.

Run: python -m backend.train_lstm --bbox -130 20 -60 55
This creates a local JSON forecast only when sufficient historical data exists.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from datetime import date
from pathlib import Path

from .app.core import ROOT, connect, summarize


def artifact_path(bbox):
    digest = hashlib.sha256(",".join(f"{x:g}" for x in bbox).encode()).hexdigest()[:16]
    return ROOT / "data" / f"forecast-{digest}.json"


def train(bbox, epochs=50):
    try:
        import torch
        from torch import nn
    except ImportError as exc:
        raise RuntimeError("Install PyTorch to train the optional LSTM model") from exc
    torch.manual_seed(19)
    area = ",".join(f"{v:g}" for v in bbox)
    with connect() as db:
        bounds = db.execute("SELECT MIN(day), MAX(day) FROM ingestions WHERE bbox = ?", (area,)).fetchone()
    if bounds[0] is None:
        raise RuntimeError("No complete-region ingestions are stored for this region")
    series = summarize(bbox, date.fromisoformat(bounds[0]), date.fromisoformat(bounds[1]))["series"]
    # Never interpret days that were not fetched as zero fire activity.
    last_gap = max((i for i, row in enumerate(series) if row["covered_sources"] < 2), default=-1)
    series = series[last_gap+1:]
    values = [float(row["occupied_cells"]) for row in series]
    if len(values) < 60 or sum(v > 0 for v in values) < 20:
        raise RuntimeError("At least 60 consecutive covered days and 20 active days are required for LSTM training")
    scale = max(1.0, max(values))
    window = 14
    x = torch.tensor([[v / scale for v in values[i:i+window]] for i in range(len(values)-window)], dtype=torch.float32).unsqueeze(-1)
    y = torch.tensor([v / scale for v in values[window:]], dtype=torch.float32).unsqueeze(-1)
    split = max(1, int(len(x) * .8))
    if len(x)-split < 7:
        raise RuntimeError("Not enough holdout days to evaluate the model")

    class Model(nn.Module):
        def __init__(self):
            super().__init__()
            self.lstm = nn.LSTM(input_size=1, hidden_size=24, batch_first=True)
            self.head = nn.Linear(24, 1)

        def forward(self, batch):
            output, _ = self.lstm(batch)
            return self.head(output[:, -1])

    model = Model()
    optimizer = torch.optim.Adam(model.parameters(), lr=.008)
    loss_fn = nn.MSELoss()
    for _ in range(epochs):
        model.train()
        optimizer.zero_grad()
        loss = loss_fn(model(x[:split]), y[:split])
        loss.backward()
        optimizer.step()
    model.eval()
    with torch.no_grad():
        holdout = model(x[split:]).flatten() * scale
        mae = sum(abs(float(p)-float(t)) for p,t in zip(holdout,y[split:].flatten()*scale)) / len(holdout)
        prediction = max(0, float(model(x[-1:]).item()) * scale)
    result = {"model": "lstm", "bbox": bbox, "trained_through": series[-1]["day"],
              "forecast_next_day_cells": round(prediction, 1), "holdout_mae_cells": round(mae, 1),
              "training_days": len(values), "holdout_days": len(holdout),
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
