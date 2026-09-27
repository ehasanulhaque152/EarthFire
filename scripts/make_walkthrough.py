"""Render a captioned EarthFire UI walkthrough to docs/earthfire-walkthrough.mp4.

Run the API first for current local data, then install scripts/requirements-video.txt.
The video uses an illustrated rendering of the actual dashboard controls.
"""

from __future__ import annotations

import json
import math
import sqlite3
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

import imageio.v2 as imageio
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs"
W, H, FPS = 1280, 720, 15
BG = "#071018"
PANEL = "#102029"
BORDER = "#20343d"
WHITE = "#e8f1f2"
MUTED = "#8fa6ad"
DIM = "#607d86"
ORANGE = "#f18360"
TEAL = "#51c7ca"
GOLD = "#f9a85e"


def font(size: int, bold=False):
    names = ["C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
             "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]
    for name in names:
        if Path(name).exists():
            return ImageFont.truetype(name, size)
    return ImageFont.load_default()


F = {size: font(size) for size in (11, 12, 13, 14, 16, 18, 21, 25, 30, 34, 45, 62)}
FB = {size: font(size, True) for size in (11, 12, 13, 14, 16, 18, 21, 25, 30, 34, 45, 62)}


def txt(d, pos, value, size=16, color=WHITE, bold=False, anchor=None):
    d.text(pos, value, font=(FB if bold else F)[size], fill=color, anchor=anchor)


def box(d, xy, fill=PANEL, border=BORDER, radius=12, width=1):
    d.rounded_rectangle(xy, radius=radius, fill=fill, outline=border, width=width)


def pill(d, xy, value, fill="#19333a", color=TEAL, size=12):
    box(d, xy, fill, fill, radius=16)
    txt(d, (xy[0] + 13, xy[1] + 8), value, size, color, True)


def load_data():
    database = ROOT / "data" / "earthfire.sqlite3"
    if database.exists():
        end = datetime.now(timezone.utc).date()
        start = end - timedelta(days=29)
        daily = defaultdict(lambda: {"modis_count": 0, "viirs_count": 0, "modis_frp": 0.0,
                                      "viirs_frp": 0.0, "cells": set()})
        with sqlite3.connect(database) as connection:
            for day, sensor, lat, lon, frp in connection.execute(
                "SELECT day, sensor, lat, lon, frp FROM detections WHERE day BETWEEN ? AND ? "
                "AND lon BETWEEN 88 AND 93 AND lat BETWEEN 20 AND 27", (start.isoformat(), end.isoformat())
            ):
                item = daily[day]
                key = sensor.lower()
                item[f"{key}_count"] += 1
                item[f"{key}_frp"] += frp
                item["cells"].add((math.floor(lat / .5), math.floor(lon / .5)))
            coverage = {day: count for day, count in connection.execute(
                "SELECT day, COUNT(DISTINCT source) FROM ingestions WHERE bbox = '88,20,93,27' "
                "AND day BETWEEN ? AND ? GROUP BY day", (start.isoformat(), end.isoformat())
            )}
        series = []
        for offset in range(30):
            day = (start + timedelta(days=offset)).isoformat()
            item = daily[day]
            series.append({"day": day, "modis_count": item["modis_count"],
                           "viirs_count": item["viirs_count"], "modis_frp": item["modis_frp"],
                           "viirs_frp": item["viirs_frp"], "occupied_cells": len(item["cells"]),
                           "covered_sources": coverage.get(day, 0)})
        return {"series": series}
    url = "http://127.0.0.1:8000/api/overview?west=88&south=20&east=93&north=27"
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            data = json.load(response)
        return data
    except Exception as exc:
        raise RuntimeError("Load FIRMS data locally or start the FastAPI server before rendering the walkthrough") from exc


DATA = load_data()
SERIES = DATA.get("series", [])
TOTAL = sum(row.get("modis_count", 0) + row.get("viirs_count", 0) for row in SERIES)
if TOTAL == 0:
    raise RuntimeError("Sync a region with FIRMS detections before rendering this walkthrough")
OCCUPIED = sum(row.get("occupied_cells", 0) for row in SERIES)
FRP = round(sum(row.get("modis_frp", 0) + row.get("viirs_frp", 0) for row in SERIES))
COVERED = sum(row.get("covered_sources", 0) >= 2 for row in SERIES)
VIIRS_DAY = max(SERIES, key=lambda row: row.get("viirs_count", 0), default={"day": "2026-09-26", "viirs_count": 17, "occupied_cells": 10})
MODIS_DAY = max(SERIES, key=lambda row: row.get("modis_count", 0), default={"day": "2026-09-27", "modis_count": 2, "occupied_cells": 1})


@lru_cache(maxsize=1)
def coast_arcs():
    path = ROOT / "node_modules" / "world-atlas" / "countries-110m.json"
    if not path.exists():
        return []
    topo = json.loads(path.read_text(encoding="utf-8"))
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        points = []
        for dx, dy in arc:
            x += dx
            y += dy
            points.append((x * sx + tx, y * sy + ty))
        arcs.append(points)
    return arcs


def project(lon, lat, cx, cy, radius, center_lon=90, center_lat=23):
    lat, lon, center_lat = map(math.radians, (lat, lon - center_lon, center_lat))
    cosc = math.sin(center_lat) * math.sin(lat) + math.cos(center_lat) * math.cos(lat) * math.cos(lon)
    if cosc < 0:
        return None
    x = radius * math.cos(lat) * math.sin(lon)
    y = radius * (math.cos(center_lat) * math.sin(lat) - math.sin(center_lat) * math.cos(lat) * math.cos(lon))
    return cx + x, cy - y


@lru_cache(maxsize=3)
def globe_image(radius=145):
    size = radius * 2 + 12
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    c = size // 2
    d.ellipse((c - radius - 3, c - radius - 3, c + radius + 3, c + radius + 3), fill=(35, 95, 110, 22))
    d.ellipse((c - radius, c - radius, c + radius, c + radius), fill="#102c37", outline="#315c69", width=2)
    for lat in (-60, -30, 0, 30, 60):
        pts = [project(lon, lat, c, c, radius) for lon in range(-90, 271, 3)]
        for a, b in zip(pts, pts[1:]):
            if a and b:
                d.line((a, b), fill="#31525e", width=1)
    for lon in range(-90, 271, 30):
        pts = [project(lon, lat, c, c, radius) for lat in range(-90, 91, 3)]
        for a, b in zip(pts, pts[1:]):
            if a and b:
                d.line((a, b), fill="#31525e", width=1)
    for arc in coast_arcs():
        pts = [project(lon, lat, c, c, radius + 1) for lon, lat in arc]
        for a, b in zip(pts, pts[1:]):
            if a and b and abs(a[0] - b[0]) < radius * .5:
                d.line((a, b), fill="#6cabb2", width=1)
    return im


def draw_globe(im, center=(555, 530), radius=137, layer="Harmonized", day="viirs", time=0):
    globe = globe_image(radius)
    im.alpha_composite(globe, (int(center[0] - globe.width / 2), int(center[1] - globe.height / 2)))
    d = ImageDraw.Draw(im)
    count = 10 if day == "viirs" else 1
    color = TEAL if layer == "VIIRS" else GOLD if layer == "MODIS" else ORANGE
    if (day == "viirs" and layer == "MODIS") or (day == "modis" and layer == "VIIRS"):
        count = 0
    for i in range(count):
        lon = 88.9 + (i * .41) % 3.4
        lat = 21.2 + (i * .77) % 4.1
        p = project(lon, lat, center[0], center[1], radius)
        if not p:
            continue
        x, y = p
        pulse = 4 + 2 * math.sin(time * 4 + i)
        d.ellipse((x - pulse * 1.5, y - pulse * 1.5, x + pulse * 1.5, y + pulse * 1.5), outline=color, width=1)
        d.ellipse((x - 3, y - 3, x + 3, y + 3), fill=color)


def chart(d, xy, values, color, max_value):
    x0, y0, x1, y1 = xy
    if len(values) < 2:
        values = [0, 0, 2, 8, 4]
    points = []
    for i, value in enumerate(values):
        x = x0 + (x1 - x0) * i / (len(values) - 1)
        y = y1 - (y1 - y0) * value / max(1, max_value)
        points.append((x, y))
    d.line(points, fill=color, width=3, joint="curve")


def cursor(d, x, y, pulse=0):
    if pulse > 0:
        r = 16 + 18 * pulse
        d.ellipse((x - r, y - r, x + r, y + r), outline=ORANGE, width=2)
    d.polygon([(x, y), (x, y + 25), (x + 7, y + 19), (x + 13, y + 30),
               (x + 18, y + 27), (x + 12, y + 17), (x + 23, y + 15)], fill="#ffffff", outline="#0b151b")


def base_screen():
    im = Image.new("RGBA", (W, H), BG)
    d = ImageDraw.Draw(im)
    d.rectangle((0, 0, 204, H), fill="#08141c")
    d.line((204, 0, 204, H), fill=BORDER, width=1)
    d.rounded_rectangle((22, 25, 54, 57), radius=8, fill=ORANGE)
    d.polygon(((38, 30), (31, 41), (38, 52), (45, 41)), fill="#14242a")
    txt(d, (64, 26), "earth", 25, WHITE, True)
    txt(d, (125, 26), "fire", 25, ORANGE, True)
    txt(d, (23, 94), "WORKSPACE", 11, DIM, True)
    box(d, (13, 123, 190, 160), "#172b32", "#172b32", 7)
    txt(d, (32, 132), "Overview", 14, WHITE, True)
    txt(d, (32, 176), "Analytics", 14, MUTED)
    txt(d, (32, 218), "Methodology", 14, MUTED)
    d.line((20, 268, 185, 268), fill=BORDER)
    txt(d, (23, 285), "DATA SOURCES", 11, DIM, True)
    d.ellipse((27, 321, 35, 329), fill=GOLD)
    txt(d, (44, 315), "MODIS", 14)
    txt(d, (150, 315), "1 km", 11, DIM)
    d.ellipse((27, 356, 35, 364), fill=TEAL)
    txt(d, (44, 350), "VIIRS", 14)
    txt(d, (141, 350), "375 m", 11, DIM)
    box(d, (17, 598, 189, 683), "#172b32", "#25424a", 10)
    txt(d, (31, 612), "NASA FIRMS", 14, WHITE, True)
    txt(d, (31, 636), "Near real-time active", 11, MUTED)
    txt(d, (31, 654), "fire detections.", 11, MUTED)
    d.line((205, 61, W, 61), fill=BORDER)
    txt(d, (233, 22), "Platform  /  Overview", 13, MUTED)
    d.ellipse((1125, 30, 1132, 37), fill="#54d4ae")
    txt(d, (1142, 22), "API connected", 12, MUTED)
    return im


def caption(im, label, detail, index):
    d = ImageDraw.Draw(im)
    d.rectangle((0, 653, W, H), fill="#071018")
    d.line((205, 653, W, 653), fill="#28404a", width=1)
    txt(d, (236, 670), f"{index:02d}  {label.upper()}", 13, TEAL, True)
    txt(d, (545, 667), detail, 16, WHITE)


def overview_scene(local_t, scene_index=1):
    im = base_screen()
    d = ImageDraw.Draw(im)
    txt(d, (234, 91), "EARTH OBSERVATION  /  ACTIVE FIRES", 11, TEAL, True)
    txt(d, (234, 113), "Fire intelligence,", 34, WHITE, True)
    txt(d, (510, 113), "from orbit.", 34, ORANGE, True)
    txt(d, (235, 160), "Explore where MODIS and VIIRS agree, and how fire activity evolves.", 14, MUTED)
    box(d, (1066, 112, 1239, 153), ORANGE, ORANGE, 7)
    txt(d, (1086, 122), "Sync latest data", 13, "#14242a", True)
    box(d, (234, 192, 1240, 241), PANEL, BORDER, 8)
    txt(d, (253, 206), "Bangladesh   v", 14, WHITE, True)
    d.line((435, 202, 435, 230), fill=BORDER)
    txt(d, (456, 206), "26 Sep 2026", 14)
    txt(d, (955, 208), f"{COVERED} / 30 days synced", 12, MUTED)
    card_data = [("Total detections", str(TOTAL), "MODIS + VIIRS", ORANGE),
                 ("Occupied grid cells", str(OCCUPIED), "0.5° daily cells", TEAL),
                 ("Sensor FRP", f"{FRP} MW", "Observed energy proxy", GOLD),
                 ("Activity signal", "Insufficient", "Need 8 covered days", ORANGE)]
    for i, (title, value, foot, color) in enumerate(card_data):
        x = 234 + i * 254
        box(d, (x, 257, x + 241, 357))
        txt(d, (x + 17, 272), title, 12, MUTED)
        txt(d, (x + 17, 295), value, 25 if i != 3 else 21, color if i == 3 else WHITE, True)
        txt(d, (x + 17, 330), foot, 11, DIM)
    box(d, (234, 374, 870, 638))
    txt(d, (253, 391), "GEOSPATIAL VIEW", 11, TEAL, True)
    txt(d, (253, 413), "Global fire activity", 21, WHITE, True)
    draw_globe(im, (550, 536), 90, "Harmonized", "viirs", local_t)
    d = ImageDraw.Draw(im)
    for i, (name, color) in enumerate((("Harmonized", ORANGE), ("MODIS", GOLD), ("VIIRS", TEAL))):
        x = 254 + i * (112 if i == 0 else 90)
        box(d, (x, 600, x + (106 if i == 0 else 81), 627), "#263940" if i == 0 else "#0b1b23", BORDER, 5)
        d.ellipse((x + 8, 610, x + 14, 616), fill=color)
        txt(d, (x + 21, 606), name, 11, WHITE if i == 0 else MUTED, True)
    box(d, (887, 374, 1240, 638))
    txt(d, (908, 391), "DAILY SNAPSHOT", 11, TEAL, True)
    txt(d, (908, 414), "Fire calendar", 21, WHITE, True)
    txt(d, (908, 457), "September 2026", 14, WHITE, True)
    for i, day in enumerate(range(21, 28)):
        x = 916 + i * 43
        if day == 26:
            box(d, (x - 8, 500, x + 23, 531), ORANGE, ORANGE, 6)
        txt(d, (x, 506), str(day), 12, "#102029" if day == 26 else MUTED, day == 26)
    d.line((908, 551, 1218, 551), fill=BORDER)
    txt(d, (908, 564), "VIIRS detections", 13, MUTED)
    txt(d, (1180, 564), str(VIIRS_DAY.get("viirs_count", 0)), 13, WHITE, True)
    txt(d, (908, 590), "Occupied cells", 13, MUTED)
    txt(d, (1180, 590), str(VIIRS_DAY.get("occupied_cells", 0)), 13, WHITE, True)
    if local_t < 5:
        x = 976 + (1132 - 976) * min(1, local_t / 3)
        y = 206 + (134 - 206) * min(1, local_t / 3)
        cursor(d, x, y, max(0, 1 - abs(local_t - 3) * 2))
    caption(im, "Start with a region", "Sync NASA FIRMS detections and see the latest activity.", scene_index)
    return im


def focus_scene(local_t, kind):
    im = overview_scene(local_t, 2 if kind == "date" else 3)
    d = ImageDraw.Draw(im)
    if kind == "date":
        d.rounded_rectangle((882, 369, 1244, 643), radius=12, outline=TEAL, width=3)
        d.rounded_rectangle((231, 189, 524, 244), radius=8, outline=ORANGE, width=3)
        cursor(d, 1136 - 45 * min(1, local_t / 3), 505, max(0, 1 - abs(local_t - 3) * 2))
        caption(im, "Choose a UTC day", "The calendar updates the map and daily sensor counts.", 2)
    else:
        d.rounded_rectangle((231, 371, 874, 641), radius=12, outline=TEAL, width=3)
        layer = "VIIRS" if local_t < 2 else "MODIS" if local_t < 4 else "Harmonized"
        day = "viirs" if local_t < 2 or local_t >= 4 else "modis"
        # Redraw the globe and layer controls over the base scene.
        d.rectangle((433, 437, 665, 628), fill=PANEL)
        draw_globe(im, (550, 536), 90, layer, day, local_t)
        d = ImageDraw.Draw(im)
        for i, (name, color) in enumerate((("Harmonized", ORANGE), ("MODIS", GOLD), ("VIIRS", TEAL))):
            x = 254 + i * (112 if i == 0 else 90)
            box(d, (x, 600, x + (106 if i == 0 else 81), 627), "#263940" if name == layer else "#0b1b23", BORDER, 5)
            d.ellipse((x + 8, 610, x + 14, 616), fill=color)
            txt(d, (x + 21, 606), name, 11, WHITE if name == layer else MUTED, True)
        cursor(d, 513 if layer == "VIIRS" else 393 if layer == "MODIS" else 295, 607, .35)
        caption(im, "Compare sensor layers", "VIIRS, MODIS, and harmonized cells share one map.", 3)
    return im


def trends_scene(local_t):
    im = base_screen()
    d = ImageDraw.Draw(im)
    txt(d, (234, 91), "HISTORICAL ANALYSIS", 11, TEAL, True)
    txt(d, (234, 117), "Fire activity over time", 34, WHITE, True)
    txt(d, (235, 165), "Compare raw detections and fire radiative power across the selected period.", 14, MUTED)
    box(d, (234, 210, 884, 624))
    txt(d, (258, 232), "ACTIVITY TREND", 11, TEAL, True)
    txt(d, (258, 255), "Daily observations", 21, WHITE, True)
    mode = "Detections" if local_t < 3 else "FRP"
    for i, name in enumerate(("Detections", "FRP")):
        x = 682 + i * 94
        box(d, (x, 237, x + 88, 267), "#263940" if name == mode else "#0b1b23", BORDER, 5)
        txt(d, (x + 10, 244), name, 12, WHITE if name == mode else MUTED, True)
    for i in range(4):
        y = 315 + i * 67
        d.line((273, y, 842, y), fill="#263940", width=1)
    m = [row.get("modis_count", 0) if mode == "Detections" else row.get("modis_frp", 0) for row in SERIES]
    v = [row.get("viirs_count", 0) if mode == "Detections" else row.get("viirs_frp", 0) for row in SERIES]
    h = [row.get("occupied_cells", 0) if mode == "Detections" else max(row.get("modis_frp", 0), row.get("viirs_frp", 0)) for row in SERIES]
    max_v = max([1] + m + v + h)
    chart(d, (276, 311, 839, 517), m, GOLD, max_v)
    chart(d, (276, 311, 839, 517), v, TEAL, max_v)
    chart(d, (276, 311, 839, 517), h, ORANGE, max_v)
    for i, (name, color) in enumerate((("MODIS", GOLD), ("VIIRS", TEAL), ("Harmonized", ORANGE))):
        x = 400 + i * 145
        d.line((x, 572, x + 19, 572), fill=color, width=3)
        txt(d, (x + 27, 564), name, 12, MUTED)
    box(d, (901, 210, 1240, 624))
    txt(d, (924, 232), "READ THE SIGNAL", 11, TEAL, True)
    txt(d, (924, 268), "Detections", 21, WHITE, True)
    txt(d, (924, 306), "Counts of observed hotspots", 14, MUTED)
    txt(d, (924, 358), "FRP", 21, WHITE, True)
    txt(d, (924, 396), "Fire radiative power in MW", 14, MUTED)
    d.line((924, 453, 1216, 453), fill=BORDER)
    txt(d, (924, 477), "Harmonized cells", 18, ORANGE, True)
    txt(d, (924, 514), "One occupied cell per UTC day", 14, MUTED)
    cursor(d, 743 if mode == "Detections" else 827, 250, .5 if abs(local_t - 3) < .4 else 0)
    caption(im, "Read the trends", "Switch between detection counts and FRP.", 4)
    return im


def method_scene(local_t):
    im = Image.new("RGBA", (W, H), BG)
    d = ImageDraw.Draw(im)
    txt(d, (80, 71), "THE HARMONIZATION METHOD", 13, TEAL, True)
    txt(d, (80, 113), "One grid. Two sensors.", 45, WHITE, True)
    txt(d, (80, 180), "Each satellite has a different footprint. EarthFire aligns detections by place and UTC day.", 18, MUTED)
    box(d, (78, 263, 362, 480), "#142832", "#39535b", 16)
    d.ellipse((113, 298, 138, 323), fill=GOLD)
    txt(d, (154, 293), "MODIS", 30, WHITE, True)
    txt(d, (113, 351), "~1 km hotspot", 18, MUTED)
    txt(d, (113, 388), "Terra + Aqua", 14, DIM)
    box(d, (418, 263, 702, 480), "#142832", "#39535b", 16)
    d.ellipse((453, 298, 478, 323), fill=TEAL)
    txt(d, (494, 293), "VIIRS", 30, WHITE, True)
    txt(d, (453, 351), "375 m hotspot", 18, MUTED)
    txt(d, (453, 388), "S-NPP + NOAA", 14, DIM)
    txt(d, (371, 351), "+", 45, ORANGE, True)
    d.line((713, 369, 765, 369), fill=ORANGE, width=4)
    d.polygon((765, 360, 783, 369, 765, 378), fill=ORANGE)
    box(d, (804, 263, 1200, 480), "#18343a", TEAL, 16, 2)
    txt(d, (837, 291), "DAILY 0.5° GRID", 25, WHITE, True)
    for row in range(3):
        for col in range(6):
            x, y = 842 + col * 49, 349 + row * 36
            fill = ORANGE if (row, col) in ((0, 4), (1, 3), (1, 4), (2, 2)) else "#27515b"
            d.rounded_rectangle((x, y, x + 41, y + 27), radius=4, fill=fill)
    pill(d, (80, 536, 488, 575), "HARMONIZED = ONE OCCUPIED CELL / DAY", "#18343a", TEAL, 12)
    txt(d, (80, 608), "An activity indicator — not a calibrated fire count or emergency forecast.", 16, MUTED)
    caption(im, "Understand the result", "Compare sensors without equating their pixel sizes.", 5)
    return im


def title_scene(local_t, outro=False):
    im = Image.new("RGBA", (W, H), BG)
    d = ImageDraw.Draw(im)
    for i in range(4):
        r = 118 + i * 58 + 4 * math.sin(local_t * 2)
        d.ellipse((W / 2 - r, H / 2 - r, W / 2 + r, H / 2 + r), outline="#163640", width=2)
    d.ellipse((W / 2 - 53, H / 2 - 116, W / 2 + 53, H / 2 - 10), fill="#2b583f", outline="#56ae87", width=2)
    d.ellipse((W / 2 + 35, H / 2 - 27, W / 2 + 59, H / 2 - 3), fill=ORANGE)
    if outro:
        txt(d, (W / 2, 216), "Explore the data.", 45, WHITE, True, "mm")
        txt(d, (W / 2, 278), "Understand the signal.", 45, ORANGE, True, "mm")
        txt(d, (W / 2, 469), "github.com/ehasanulhaque152/EarthFire", 18, TEAL, True, "mm")
        txt(d, (W / 2, 505), "NASA FIRMS  ·  MODIS  ·  VIIRS", 14, MUTED, False, "mm")
    else:
        txt(d, (W / 2, 210), "EARTHFIRE", 62, WHITE, True, "mm")
        txt(d, (W / 2, 280), "FIRE INTELLIGENCE FROM ORBIT", 18, TEAL, True, "mm")
        txt(d, (W / 2, 485), "A 36-second illustrated product walkthrough", 18, MUTED, False, "mm")
    return im


def frame(t):
    if t < 3:
        return title_scene(t)
    if t < 9:
        return overview_scene(t - 3)
    if t < 15:
        return focus_scene(t - 9, "date")
    if t < 21:
        return focus_scene(t - 15, "layers")
    if t < 27:
        return trends_scene(t - 21)
    if t < 33:
        return method_scene(t - 27)
    return title_scene(t - 33, outro=True)


def main():
    OUT.mkdir(exist_ok=True)
    path = OUT / "earthfire-walkthrough.mp4"
    poster = frame(5).convert("RGB")
    poster.save(OUT / "earthfire-walkthrough-poster.png", optimize=True)
    writer = imageio.get_writer(path, fps=FPS, codec="libx264", quality=8, macro_block_size=None,
                                output_params=["-movflags", "+faststart"])
    try:
        for i in range(36 * FPS):
            im = frame(i / FPS).convert("RGB")
            writer.append_data(np.asarray(im))
            if i % (5 * FPS) == 0:
                print(f"Rendered {i // FPS:02d}/36 seconds", flush=True)
    finally:
        writer.close()
    print(path)


if __name__ == "__main__":
    main()
