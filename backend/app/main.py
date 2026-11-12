from datetime import date, timedelta
import calendar
import asyncio
import os
from pathlib import Path
import re
import time

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import httpx
from pydantic import BaseModel, Field
from fastapi.staticfiles import StaticFiles

from .core import SOURCES, connect, ingest, next_day_forecast, statistical_risk, summarize
from backend.train_lstm import artifact_path
import json

app = FastAPI(title="EarthFire API", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"], allow_methods=["GET", "POST"], allow_headers=["*"])
INGEST_COOLDOWN_SECONDS = 1
ingest_lock = asyncio.Lock()
last_ingest_at: dict[tuple, float] = {}


class HistoryMonthRequest(BaseModel):
    bbox: tuple[float, float, float, float] = (-130, 20, -60, 55)
    year: int = Field(ge=2000, le=2100)
    month: int = Field(ge=1, le=12)


class IngestRequest(BaseModel):
    bbox: tuple[float, float, float, float] = (-130, 20, -60, 55)
    days: int = Field(default=3, ge=1, le=5)
    sources: list[str] | None = None
    start_date: date | None = None


def valid_bbox(bbox):
    w, s, e, n = bbox
    if not (-180 <= w < e <= 180 and -90 <= s < n <= 90):
        raise HTTPException(422, "bbox must be west,south,east,north")
    return bbox


@app.get("/api/health")
def health():
    with connect() as db:
        rows = db.execute("SELECT COUNT(*) FROM detections").fetchone()[0]
        latest_observation_day = db.execute("SELECT MAX(day) FROM detections").fetchone()[0]
    return {
        "status": "ok",
        "detections": rows,
        "latest_observation_day": latest_observation_day,
        "firms_configured": bool(os.getenv("FIRMS_MAP_KEY")),
    }


@app.get("/api/overview")
def overview(
    west: float = -130, south: float = 20, east: float = -60, north: float = 55,
    start: date | None = None, end: date | None = None,
):
    bbox = valid_bbox((west, south, east, north))
    end = end or date.today()
    start = start or end - timedelta(days=29)
    if start > end or (end - start).days > 365:
        raise HTTPException(422, "Select a range of 1–366 days")
    data = summarize(bbox, start, end)
    complete_series = data["series"][:-1] if end == date.today() else data["series"]
    last_gap = max((i for i, row in enumerate(complete_series) if row["covered_sources"] < 2), default=-1)
    risk_series = complete_series[last_gap+1:]
    data.update({"bbox": bbox, "start": start, "end": end, "risk": statistical_risk(risk_series),
        "prediction": next_day_forecast(data["series"])})
    artifact = artifact_path(bbox)
    if artifact.exists():
        forecast = json.loads(artifact.read_text(encoding="utf-8"))
        covered_days = [row["day"] for row in data["series"] if row["covered_sources"] >= 2]
        recent = covered_days and date.fromisoformat(covered_days[-1]) >= end - timedelta(days=1)
        data["forecast"] = forecast if recent and forecast.get("trained_through") == covered_days[-1] else None
    else:
        data["forecast"] = None
    return data


@app.post("/api/history/month")
async def history_month(body: HistoryMonthRequest):
    bbox = valid_bbox(body.bbox)
    today = date.today()
    if (body.year, body.month) > (today.year, today.month):
        raise HTTPException(422, "Choose a month that has started")
    start = date(body.year, body.month, 1)
    end = min(date(body.year, body.month, calendar.monthrange(body.year, body.month)[1]), today)
    source_families = [
        ("MODIS_NRT", "MODIS_SP"),
        ("VIIRS_SNPP_NRT", "VIIRS_SNPP_SP"),
        ("VIIRS_NOAA20_NRT", "VIIRS_NOAA20_SP"),
        ("VIIRS_NOAA21_NRT", "VIIRS_NOAA21_SP"),
    ]
    map_key = os.getenv("FIRMS_MAP_KEY", "")
    if map_key:
        area = ",".join(f"{v:g}" for v in bbox)
        async with ingest_lock:
            try:
                day = start
                while day <= end:
                    chunk_end = min(day + timedelta(days=4), end)
                    chunk_days = (chunk_end - day).days + 1
                    source_index = 0 if day >= today - timedelta(days=60) else 1
                    for family in source_families:
                        source = family[source_index]
                        with connect() as db:
                            cached = db.execute(
                                "SELECT COUNT(*) FROM ingestions WHERE source=? AND bbox=? AND day BETWEEN ? AND ?",
                                (source, area, day.isoformat(), chunk_end.isoformat()),
                            ).fetchone()[0]
                        if cached < chunk_days:
                            await ingest(map_key, bbox, chunk_days, [source], day)
                    day = chunk_end + timedelta(days=1)
            except httpx.HTTPStatusError as exc:
                message = re.sub(r"\s+", " ", exc.response.text).strip().replace(map_key, "[redacted]")[:180]
                raise HTTPException(502, f"NASA FIRMS history request failed: HTTP {exc.response.status_code}. {message}") from exc
            except ValueError as exc:
                raise HTTPException(502, str(exc)) from exc
            except Exception as exc:
                raise HTTPException(502, f"FIRMS history request failed: {type(exc).__name__}") from exc
    data = summarize(bbox, start, end)
    data.update({"bbox": bbox, "start": start, "end": end, "risk": statistical_risk(data["series"]), "forecast": None})
    return data


@app.post("/api/ingest/recent")
async def ingest_recent(body: IngestRequest):
    bbox = valid_bbox(body.bbox)
    map_key = os.getenv("FIRMS_MAP_KEY", "")
    if not map_key:
        raise HTTPException(503, "FIRMS_MAP_KEY is missing")
    today = date.today()
    history_start = today - timedelta(days=16)
    history_end = today - timedelta(days=3)
    area = ",".join(f"{v:g}" for v in bbox)
    async with ingest_lock:
        try:
            day = history_start
            while day <= history_end:
                chunk_end = min(day + timedelta(days=4), history_end)
                chunk_days = (chunk_end - day).days + 1
                for source in SOURCES:
                    if source not in ("MODIS_NRT", "VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"):
                        continue
                    with connect() as db:
                        cached = db.execute(
                            "SELECT COUNT(*) FROM ingestions WHERE source=? AND bbox=? AND day BETWEEN ? AND ?",
                            (source, area, day.isoformat(), chunk_end.isoformat()),
                        ).fetchone()[0]
                    if cached < chunk_days:
                        await ingest(map_key, bbox, chunk_days, [source], day)
                day = chunk_end + timedelta(days=1)
            latest = await ingest(map_key, bbox, 3, None, None)
        except httpx.HTTPStatusError as exc:
            message = re.sub(r"\\s+", " ", exc.response.text).strip().replace(map_key, "[redacted]")[:180]
            raise HTTPException(502, f"NASA FIRMS history sync failed: HTTP {exc.response.status_code}. {message}") from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except Exception as exc:
            raise HTTPException(502, f"FIRMS history sync failed: {type(exc).__name__}") from exc
    return {
        "history_days": (history_end - history_start).days + 1,
        "received": sum(item["received"] for item in latest),
        "sources": latest,
    }


@app.post("/api/ingest")
async def ingest_route(body: IngestRequest):
    global last_ingest_at
    bbox = valid_bbox(body.bbox)
    if body.sources and any(s not in SOURCES for s in body.sources):
        raise HTTPException(422, "Unknown FIRMS source")
    cache_key = (bbox, tuple(body.sources or ()), body.days, body.start_date)
    async with ingest_lock:
        remaining = INGEST_COOLDOWN_SECONDS - (time.monotonic() - last_ingest_at.get(cache_key, 0))
        if remaining > 0:
            raise HTTPException(429, f"This region was synced recently. Try again in {int(remaining) + 1} seconds.")
        try:
            sources = await ingest(os.getenv("FIRMS_MAP_KEY", ""), bbox, body.days, body.sources, body.start_date)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except httpx.HTTPStatusError as exc:
            map_key = os.getenv("FIRMS_MAP_KEY", "")
            nasa_message = re.sub(r"\s+", " ", exc.response.text).strip()
            if map_key:
                nasa_message = nasa_message.replace(map_key, "[redacted]")
            nasa_message = nasa_message[:180]
            reason = f" {nasa_message}" if nasa_message else ""
            raise HTTPException(
                502,
                f"NASA FIRMS returned HTTP {exc.response.status_code}.{reason}",
            ) from exc
        except Exception as exc:
            raise HTTPException(502, f"FIRMS request failed: {type(exc).__name__}") from exc
        last_ingest_at[cache_key] = time.monotonic()
    return {"sources": sources, "received": sum(s["received"] for s in sources)}


# In the deployed container, serve the built React app from the same origin as
# the API. Local development keeps using Vite's /api proxy instead.
frontend_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if frontend_dist.is_dir():
    app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")

