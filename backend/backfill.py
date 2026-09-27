"""Import a bounded historical FIRMS interval in API-compliant five-day chunks.

Example: python -m backend.backfill --bbox 88 20 93 27 --start 2026-07-01 --end 2026-08-31 --sources MODIS_NRT VIIRS_NOAA20_NRT
Choose NRT or SP sources according to FIRMS data availability for the dates.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from datetime import date, timedelta

from .app.core import SOURCES, ingest


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bbox", nargs=4, type=float, required=True, metavar=("WEST", "SOUTH", "EAST", "NORTH"))
    parser.add_argument("--start", type=date.fromisoformat, required=True)
    parser.add_argument("--end", type=date.fromisoformat, required=True)
    parser.add_argument("--sources", nargs="+", choices=sorted(SOURCES), required=True)
    args = parser.parse_args()
    if args.start > args.end:
        parser.error("--start must be on or before --end")
    cursor = args.start
    while cursor <= args.end:
        days = min(5, (args.end - cursor).days + 1)
        result = await ingest(os.getenv("FIRMS_MAP_KEY", ""), tuple(args.bbox), days, args.sources, cursor)
        print(json.dumps({"start": cursor.isoformat(), "days": days, "sources": result}))
        cursor += timedelta(days=days)


if __name__ == "__main__":
    asyncio.run(main())
