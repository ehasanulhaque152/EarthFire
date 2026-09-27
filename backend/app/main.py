from datetime import date, timedelta
import os

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .core import SOURCES, connect, ingest, statistical_risk, summarize
from backend.train_lstm import artifact_path
import json

app = FastAPI(title="EarthFire API", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"], allow_methods=["GET", "POST"], allow_headers=["*"])


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
    return {"status": "ok", "detections": rows, "firms_configured": bool(os.getenv("FIRMS_MAP_KEY"))}


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
    data.update({"bbox": bbox, "start": start, "end": end, "risk": statistical_risk(risk_series)})
    artifact = artifact_path(bbox)
    if artifact.exists():
        forecast = json.loads(artifact.read_text(encoding="utf-8"))
        covered_days = [row["day"] for row in data["series"] if row["covered_sources"] >= 2]
        recent = covered_days and date.fromisoformat(covered_days[-1]) >= end - timedelta(days=1)
        data["forecast"] = forecast if recent and forecast.get("trained_through") == covered_days[-1] else None
    else:
        data["forecast"] = None
    return data


@app.post("/api/ingest")
async def ingest_route(body: IngestRequest):
    bbox = valid_bbox(body.bbox)
    if body.sources and any(s not in SOURCES for s in body.sources):
        raise HTTPException(422, "Unknown FIRMS source")
    try:
        sources = await ingest(os.getenv("FIRMS_MAP_KEY", ""), bbox, body.days, body.sources, body.start_date)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, f"FIRMS request failed: {type(exc).__name__}") from exc
    return {"sources": sources, "received": sum(s["received"] for s in sources)}
