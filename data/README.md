# Fire observation snapshot

`earthfire.sqlite3` is a snapshot of 74,055 NASA FIRMS MODIS and VIIRS active-fire detections captured from the local EarthFire database on 2026-09-29. The API reads this file by default. It is a snapshot, not a live feed; the Sync latest data action can update a local copy.

Source: [NASA FIRMS Area API](https://firms.modaps.eosdis.nasa.gov/api/area/). The database contains `detections` and `ingestions` tables and no FIRMS API key.
