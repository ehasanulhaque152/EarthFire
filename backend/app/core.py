from __future__ import annotations

import csv
import io
import math
import os
import sqlite3
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import httpx
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")
DB_PATH = Path(os.getenv("EARTHFIRE_DB", ROOT / "data" / "earthfire.sqlite3"))
FIRMS_URL = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"
SOURCES = {"MODIS_NRT": "MODIS", "VIIRS_SNPP_NRT": "VIIRS", "VIIRS_NOAA20_NRT": "VIIRS", "VIIRS_NOAA21_NRT": "VIIRS", "MODIS_SP": "MODIS", "VIIRS_SNPP_SP": "VIIRS", "VIIRS_NOAA20_SP": "VIIRS"}
LIVE_SOURCES = ["MODIS_NRT", "VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"]
GRID_DEG = 0.5


def connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS detections (
          id TEXT PRIMARY KEY, source TEXT NOT NULL, sensor TEXT NOT NULL,
          observed_at TEXT NOT NULL, day TEXT NOT NULL,
          lat REAL NOT NULL, lon REAL NOT NULL, frp REAL NOT NULL,
          confidence TEXT, satellite TEXT
        );
        CREATE INDEX IF NOT EXISTS ix_detections_day ON detections(day);
        CREATE INDEX IF NOT EXISTS ix_detections_location ON detections(lat, lon);
        CREATE TABLE IF NOT EXISTS ingestions (
          source TEXT NOT NULL, day TEXT NOT NULL, bbox TEXT NOT NULL,
          rows INTEGER NOT NULL, fetched_at TEXT NOT NULL,
          PRIMARY KEY(source, day, bbox)
        );
    """)
    return db


def parse_rows(body: str, source: str):
    if body.lstrip().startswith("<") or body.lstrip().startswith("Error"):
        raise ValueError("FIRMS returned an error instead of CSV")
    reader = csv.DictReader(io.StringIO(body))
    if not reader.fieldnames or not {"latitude", "longitude", "acq_date"}.issubset(reader.fieldnames):
        raise ValueError("FIRMS response does not contain expected columns")
    rows = []
    for row in reader:
        try:
            lat, lon = float(row["latitude"]), float(row["longitude"])
            frp = max(0.0, float(row.get("frp") or 0))
            day = date.fromisoformat(row["acq_date"]).isoformat()
            hhmm = (row.get("acq_time") or "0").zfill(4)
            stamp = f"{day}T{hhmm[:2]}:{hhmm[2:]}:00Z"
            satellite = row.get("satellite") or ""
            identity = "|".join((source, stamp, f"{lat:.5f}", f"{lon:.5f}", satellite))
            rows.append((identity, source, SOURCES[source], stamp, day, lat, lon, frp, row.get("confidence"), satellite))
        except (ValueError, TypeError, KeyError):
            continue
    return rows


async def ingest(map_key: str, bbox: tuple[float, float, float, float], days: int = 3, sources: list[str] | None = None, start_date: date | None = None):
    if not map_key:
        raise ValueError("FIRMS_MAP_KEY is missing")
    if not (1 <= days <= 5):
        raise ValueError("FIRMS accepts 1–5 days per area request")
    sources = sources or LIVE_SOURCES
    if any(source not in SOURCES for source in sources):
        raise ValueError("Unknown FIRMS source")
    area = ",".join(f"{v:g}" for v in bbox)
    results = []
    async with httpx.AsyncClient(timeout=75, follow_redirects=True) as client:
        for source in sources:
            url = f"{FIRMS_URL}/{map_key}/{source}/{area}/{days}"
            if start_date:
                url += f"/{start_date.isoformat()}"
            response = await client.get(url)
            response.raise_for_status()
            rows = parse_rows(response.text, source)
            with connect() as db:
                db.executemany("INSERT OR REPLACE INTO detections VALUES (?,?,?,?,?,?,?,?,?,?)", rows)
                now = datetime.now(timezone.utc).isoformat()
                first_day = start_date or datetime.now(timezone.utc).date() - timedelta(days=days-1)
                for offset in range(days):
                    day = (first_day + timedelta(days=offset)).isoformat()
                    db.execute("INSERT OR REPLACE INTO ingestions VALUES (?,?,?,?,?)", (source, day, area, sum(r[4] == day for r in rows), now))
            results.append({"source": source, "received": len(rows)})
    return results


def cell_key(lat: float, lon: float):
    return (math.floor(lat / GRID_DEG), math.floor(lon / GRID_DEG))


def cell_area_km2(lat_center: float):
    earth_radius = 6371.0088
    south, north = map(math.radians, (lat_center - GRID_DEG / 2, lat_center + GRID_DEG / 2))
    return earth_radius**2 * math.radians(GRID_DEG) * (math.sin(north) - math.sin(south))


def summarize(bbox: tuple[float, float, float, float], start: date, end: date):
    west, south, east, north = bbox
    with connect() as db:
        raw = db.execute("""SELECT day, source, sensor, lat, lon, frp FROM detections
          WHERE day BETWEEN ? AND ? AND lon BETWEEN ? AND ? AND lat BETWEEN ? AND ?""",
          (start.isoformat(), end.isoformat(), west, east, south, north)).fetchall()
        latest = db.execute("SELECT MAX(fetched_at) AS updated FROM ingestions").fetchone()["updated"]
        area = ",".join(f"{v:g}" for v in bbox)
        covered = {row["day"]: row["sources"] for row in db.execute("SELECT day, COUNT(DISTINCT source) AS sources FROM ingestions WHERE bbox = ? AND day BETWEEN ? AND ? GROUP BY day", (area, start.isoformat(), end.isoformat()))}
    grouped = defaultdict(lambda: {"MODIS": {"count": 0, "frp": 0.0}, "VIIRS": {"count": 0, "frp": 0.0}, "sources": set()})
    daily = defaultdict(lambda: {"MODIS": 0, "VIIRS": 0, "MODIS_frp": 0.0, "VIIRS_frp": 0.0, "cells": set()})
    for row in raw:
        key = (row["day"], *cell_key(row["lat"], row["lon"]))
        group = grouped[key]
        group[row["sensor"]]["count"] += 1
        group[row["sensor"]]["frp"] += row["frp"]
        group["sources"].add(row["source"])
        d = daily[row["day"]]
        d[row["sensor"]] += 1
        d[f'{row["sensor"]}_frp'] += row["frp"]
        d["cells"].add(key[1:])
    cells = []
    for (day, y, x), val in sorted(grouped.items()):
        lat, lon = (y + .5) * GRID_DEG, (x + .5) * GRID_DEG
        area = cell_area_km2(lat)
        m, v = val["MODIS"], val["VIIRS"]
        # Presence is a common spatial unit. It is not a calibrated fire count.
        cells.append({"day": day, "lat": lat, "lon": lon, "area_km2": round(area, 2),
          "modis_count": m["count"], "viirs_count": v["count"],
          "modis_frp": round(m["frp"], 2), "viirs_frp": round(v["frp"], 2),
          "occupied": 1, "density": round(1000 / area, 4),
          "harmonized_frp": round(max(m["frp"], v["frp"]), 2),
          "sources": sorted(val["sources"])})
    series = []
    current = start
    while current <= end:
        d = daily[current.isoformat()]
        series.append({"day": current.isoformat(), "modis_count": d["MODIS"],
          "viirs_count": d["VIIRS"], "modis_frp": round(d["MODIS_frp"], 2),
          "viirs_frp": round(d["VIIRS_frp"], 2), "occupied_cells": len(d["cells"]), "covered_sources": covered.get(current.isoformat(), 0)})
        current += timedelta(days=1)
    return {"cells": cells, "series": series, "total_detections": len(raw), "updated_at": latest,
      "method": {"grid_degrees": GRID_DEG, "harmonized_count": "one occupied cell per UTC day",
        "harmonized_frp": "larger sensor-specific FRP sum per cell; exploratory proxy",
        "density": "occupied cells per 1,000 km² of observed cell area"}}


def statistical_risk(series: list[dict]):
    history = [row["occupied_cells"] for row in series]
    if not history:
        return {"level": "unknown", "score": 0, "trend": "unknown", "model": "statistics", "message": "No historical observations"}
    recent = history[-1]
    baseline = history[:-1][-14:]
    if len(baseline) < 7:
        return {"level": "insufficient history", "score": 0, "trend": "unknown", "model": "statistics", "message": "Need 8 covered days"}
    mean = sum(baseline) / len(baseline)
    variance = sum((x - mean)**2 for x in baseline) / len(baseline)
    z = (recent - mean) / max(1.0, math.sqrt(variance))
    score = max(0, min(100, round(50 + 18 * z)))
    level = "high" if z >= 1.5 else "elevated" if z >= .5 else "normal"
    return {"level": level, "score": score, "trend": "rising" if recent > mean * 1.1 else "falling" if recent < mean * .9 else "steady",
      "model": "statistics", "message": f"Latest {recent} occupied cells; prior mean {mean:.1f}"}
