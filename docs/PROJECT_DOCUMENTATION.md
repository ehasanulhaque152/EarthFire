# EarthFire: project documentation

This guide describes the code in this repository as built on 27 September 2026. EarthFire is an exploratory NASA FIRMS active-fire dashboard. It compares MODIS and VIIRS observations on a common daily grid, stores retrieved observations locally, displays them on a 3D globe, and can train an optional TensorFlow forecast after enough history has been collected. The design follows the architecture supplied for the project; it does not claim scientific sensor calibration or operational fire-risk prediction.

## 1. System architecture

```text
NASA FIRMS Area CSV API
  MODIS NRT / SP       VIIRS S-NPP, NOAA-20, NOAA-21 NRT / selected SP
           \            /
            FastAPI ingest + CSV validation
                       |
              SQLite detections and ingestion coverage
                       |
          UTC date + 0.5° latitude/longitude grid
                       |
          per-sensor counts and FRP; occupied cells
                       |
              GET /api/overview
                /             \
       statistical activity   optional TensorFlow LSTM JSON
                \             /
                React dashboard
         3D globe, calendar, layers, charts
```

The browser talks to the local FastAPI server through Vite's `/api` proxy during development. The browser never sends the FIRMS key to NASA. The backend reads the key from `.env` and makes the FIRMS request. SQLite is the historical store; it is not a separate hosted database.

## 2. Tools and why they were chosen

| Tool | Role | Reason |
| --- | --- | --- |
| Python + FastAPI | HTTP API and ingestion | Typed request validation and automatic `/docs` API reference. |
| `httpx` | FIRMS requests | Asynchronous HTTP client with timeout and error handling. |
| `csv.DictReader` | CSV parser | Uses FIRMS column names rather than relying on column order. |
| SQLite | Local historical storage | No external service is needed for a prototype; primary keys make repeat imports safe. |
| React + TypeScript | Dashboard | Component state handles region, day, layer, metric, loading and errors; types document the API response. |
| Vite | Frontend development/build | Fast local server and `/api` proxy. |
| Three.js | Globe | WebGL sphere, country boundaries, rotation and observation markers. |
| `world-atlas` + `topojson-client` | Country outlines | Supplies geographic boundaries for the globe; this is visual context, not fire training data. |
| SVG | Trend chart and sparklines | Lightweight charts drawn from API series without another chart package. |
| TensorFlow/Keras + NumPy | Optional LSTM | Trains a small sequence model for next-day occupied-cell counts. |
| Pillow + ImageIO/FFmpeg | Walkthrough video | Renders a captioned, illustrated UI demonstration to MP4. |

The frontend's Lucide icons provide navigation and metric symbols. CSS in `frontend/src/style.css` controls the responsive dark layout. Prettier formats the frontend source; TypeScript checks frontend types.

## 3. NASA FIRMS data and the map key

**Yes, EarthFire uses the NASA FIRMS API and your FIRMS map key.** The call is made by `backend/app/core.py` to the [FIRMS Area CSV endpoint](https://firms.modaps.eosdis.nasa.gov/api/area/):

```text
https://firms.modaps.eosdis.nasa.gov/api/area/csv/<MAP_KEY>/<SOURCE>/<WEST,SOUTH,EAST,NORTH>/<DAYS>[/<START_DATE>]
```

`<DAYS>` is 1–5. Without `<START_DATE>`, FIRMS returns its most recent days; with a date, it returns the interval starting on that date. NASA documents the parameters and available sources on the [Area API page](https://firms.modaps.eosdis.nasa.gov/api/area/). Request a free key from NASA's [Map Key page](https://firms.modaps.eosdis.nasa.gov/api/map_key/). The key is a FIRMS access key, not an Earthdata Login password.

The key is stored as `FIRMS_MAP_KEY` in the local `.env` file. `.env` is ignored by Git; `.env.example` contains only a placeholder. `load_dotenv()` runs in `core.py`, and `POST /api/ingest` passes the environment value to `ingest()`. `GET /api/health` returns only whether a key is configured. The API does not include the key in its JSON response. Avoid printing full FIRMS URLs because the key is part of the URL path. If the key is ever published, replace it through NASA's key management page.

The default live request uses `MODIS_NRT`, `VIIRS_SNPP_NRT`, `VIIRS_NOAA20_NRT`, and `VIIRS_NOAA21_NRT`. `SOURCES` in `core.py` also allows selected standard-processing (`SP`) sources for historical imports. Consult NASA's [Data Availability API](https://firms.modaps.eosdis.nasa.gov/api/data_availability/) for the actual date range of each source before backfilling. NASA distinguishes recent NRT data from delayed SP data in its [API tutorial](https://firms.modaps.eosdis.nasa.gov/content/academy/data_api/firms_api_use.html). As of this document's date, FIRMS also announces an upcoming end to S-NPP delivery on 1 November 2026; update the default source list when NASA's service changes.

### Dataset columns used

The parser requires `latitude`, `longitude`, and `acq_date`. It also reads `acq_time`, `frp`, `confidence`, and `satellite` when present. Each accepted row becomes one detection with a UTC-style timestamp, source name, sensor family, coordinate and FRP. Malformed rows are skipped. The current implementation does **not** filter by confidence or distinguish vegetation fires from other thermal anomalies; consult each FIRMS product's attribute documentation before applying such filters.

## 4. Run the project

Install Node.js 20+ and Python 3.11–3.13 if you intend to use TensorFlow. The API/frontend can use a newer Python version if its dependencies support it, but the documented ML environment is 3.11–3.13.

```powershell
Copy-Item .env.example .env
# Edit .env locally and set FIRMS_MAP_KEY; never commit this file.
python -m venv .venv
.\.venv\Scripts\python -m pip install -r backend\requirements.txt
```

Start the backend and frontend in separate terminals:

```powershell
.\.venv\Scripts\python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000 --reload
```

In the frontend terminal, run:

```powershell
Set-Location frontend
npm install
npm run dev
```

Open `http://127.0.0.1:5173/`; API documentation is at `http://127.0.0.1:8000/docs`. The dashboard initially requests the last 30 days for Bangladesh. Click **Sync latest data** to fetch the selected region's latest three days. The sync button requires a reachable backend and configured key. A SQLite snapshot is committed at `data/earthfire.sqlite3`; forecasts and later data changes are local. Set `EARTHFIRE_DB` if you need another SQLite path.

## 5. Backend implementation

### Database and ingestion

`connect()` creates two tables in `data/earthfire.sqlite3` and enables SQLite write-ahead logging:

| Table | Main fields | Purpose |
| --- | --- | --- |
| `detections` | `id`, `source`, `sensor`, `observed_at`, `day`, `lat`, `lon`, `frp`, `confidence`, `satellite` | One accepted FIRMS detection per row. `id` is a primary key. |
| `ingestions` | `source`, `day`, `bbox`, `rows`, `fetched_at` | Records that a particular source/day/bounding box was fetched, including a valid zero-row day. |

`parse_rows()` checks that the response resembles CSV and contains required columns. It converts coordinates and FRP, builds an acquisition timestamp from `acq_date` and zero-padded `acq_time`, and creates an identity from source, timestamp, rounded coordinate and satellite. `INSERT OR REPLACE` makes retrying the same request idempotent for identical identities. FRP below zero is clamped to zero. The parser currently assumes the FIRMS acquisition date/time is UTC.

`ingest()` validates the map key, source names and 1–5 day request length. It requests each source sequentially with `httpx`, parses the CSV, writes detections, and writes one coverage row for every requested day. The exact bounding-box string is part of the coverage key. If NASA returns an HTTP error or unexpected CSV, the route reports a failure rather than silently treating it as a day without fires.

### Harmonization and summary

`summarize()` selects detections for the requested date range and bounding box, then groups each observation by `(UTC day, floor(latitude / 0.5), floor(longitude / 0.5))`. Cell centers are derived from those integer indexes. A spherical latitude-band formula estimates cell area; east-west area decreases away from the equator.

For every occupied daily cell, the response keeps:

- separate MODIS and VIIRS detection counts;
- separate sums of fire radiative power (FRP) in MW;
- `occupied = 1` if either sensor has at least one detection;
- density of that occupied cell as `1000 / cell_area_km2` occupied cells per 1,000 km²;
- `harmonized_frp = max(modis_frp, viirs_frp)` as an **exploratory proxy**.

The daily series contains separate sensor totals, number of occupied cells and `covered_sources`. The series includes every requested calendar day, even when no rows were received. `covered_sources` lets the application distinguish a fetched zero-detection day from an unfetched day. The current harmonization does not pair individual MODIS and VIIRS detections into physical fires, resample their footprints, correct overpass timing, or calibrate FRP across sensors. One occupied grid cell is an activity measure, not a fire count or burned area.

### Statistical activity signal

`GET /api/overview` excludes the current UTC day from the signal because that day may be incomplete. It takes the contiguous suffix of days with at least two fetched sources. `statistical_risk()` compares its latest occupied-cell count with up to 14 prior counts. It needs at least seven baseline days; otherwise it reports `insufficient history`. Its score is a clipped transformation of a z-like deviation and its labels are `normal`, `elevated`, or `high`. The label is **relative activity**, not wildfire probability or emergency risk.

### HTTP endpoints

| Endpoint | Input | Output |
| --- | --- | --- |
| `GET /api/health` | none | API status, stored detection count, boolean key status. |
| `GET /api/overview` | `west`, `south`, `east`, `north`, optional `start`, `end` | Daily cells, series, source coverage, method metadata, activity signal, optional saved forecast. Range is capped at 366 days. |
| `POST /api/ingest` | JSON `bbox`, `days` (1–5), optional `sources`, `start_date` | Per-source received row counts and total. Calls NASA FIRMS. |

Bounding boxes are `[west, south, east, north]` and validated against world coordinate ranges. During local development CORS allows `localhost:5173` and `127.0.0.1:5173`. CORS is not authentication; the ingest endpoint should be protected and rate limited before a public deployment with a private FIRMS key.

### Historical importer

`backend/backfill.py` accepts a bounding box, start/end dates and source list. It loops from the start date in chunks of at most five days and reuses `ingest()`. It prints a compact result for each chunk. Large areas and many sources consume more FIRMS transactions and database space. Its current loop is sequential so it does not flood the upstream service.

## 6. Frontend implementation

`frontend/src/App.tsx` contains the page and typed `Cell`, `Day`, and `Overview` response structures. It stores region, selected UTC day, map layer, chart metric and connection/loading/error states with React hooks. A region change triggers `load()`, which requests a 30-day overview and `/api/health`. The sync button posts a three-day request to `/api/ingest`, then reloads the overview. The frontend does not embed the FIRMS key.

The metric cards show totals for the loaded 30-day window, while the calendar and globe show the selected day. The layer buttons filter that day's cells to MODIS, VIIRS, or all occupied cells. The trends chart uses SVG polylines for sensor counts or FRP. Its displayed “harmonized FRP proxy” uses the larger **daily** sensor FRP total, whereas `core.py` returns the larger sensor sum **per cell** in each cell record. Both are exploratory display proxies and should not be treated as calibrated energy totals. `frontend/src/style.css` defines layout, responsive rules, colors and control states.

`frontend/src/Globe.tsx` creates a Three.js sphere, atmosphere, latitude/longitude grid, country outlines and point markers. It converts geographic coordinates to 3D Cartesian coordinates, focuses the globe on the chosen region, lets the user drag to rotate, and resizes the WebGL canvas with `ResizeObserver`. Marker color identifies the selected layer; marker size grows logarithmically with the value. For browser performance it displays at most 1,000 points and disposes geometries/materials when markers change or the component unmounts.

`frontend/src/style.css` lays out the sidebar and main content, styles loading/connection and layer states, and adapts the metric, globe, calendar and lower chart sections at 1200 px, 850 px and 560 px breakpoints. `frontend/src/main.tsx` mounts `App` under React Strict Mode. `frontend/index.html` supplies the root element, tab title, theme color and Google Fonts links; a network connection is needed to fetch those web fonts, while local fallback fonts still render the page.

## 7. Finding historical data and training the LSTM

1. **Choose a region and target.** This code predicts the next day's number of occupied 0.5° cells for one bounding box. It does not predict fire ignition, burned area, severity or a probability.
2. **Check source dates.** Use NASA's [Data Availability page](https://firms.modaps.eosdis.nasa.gov/api/data_availability/) with your own key. Select one MODIS and one VIIRS source that cover the desired dates. For recent dates use an available NRT source; for older scientific analysis prefer the corresponding SP record when available. NASA notes that archived NRT is replaced by SP after a lag on its [Active Fire Data page](https://firms.modaps.eosdis.nasa.gov/active_fire/).
3. **Collect a continuous interval.** Run `backend.backfill` for a bounded area and a date range that both sources actually cover. The example below is only a command pattern; change dates and source names after checking availability.

   ```powershell
   .\.venv\Scripts\python -m backend.backfill --bbox 88 20 93 27 --start YYYY-MM-DD --end YYYY-MM-DD --sources MODIS_NRT VIIRS_NOAA20_NRT
   ```

4. **Verify coverage.** The trainer needs at least 60 consecutive days after the latest coverage gap, with at least two fetched sources per day and at least 20 days with nonzero occupied cells. Two fetched sources currently means any two source names; the code does not enforce one MODIS plus one VIIRS. Check the `ingestions` table for your exact bbox and compare the API's `series[].covered_sources` and `occupied_cells` before training. A fetched day with zero detections is valid; a day that was never fetched is not a zero-fire day.
5. **Install and train.** Use a Python 3.11–3.13 environment for the optional TensorFlow package:

   ```powershell
   .\.venv\Scripts\python -m pip install -r backend\requirements-ml.txt
   .\.venv\Scripts\python -m backend.train_lstm --bbox 88 20 93 27 --epochs 50
   ```

`fit_lstm()` turns the daily occupied-cell counts into 14-day input windows and next-day targets. It holds out the final 20% of windows in time order; scaling uses only the training interval. The Keras model is `Input(14, 1) → LSTM(24) → Dense(1)`, trained with Adam and mean squared error. It reports holdout mean absolute error in **cells**, then predicts from the latest 14 actual days. The random seed is fixed for repeatability. There is no hyperparameter search, baseline comparison, uncertainty interval, or full-data refit after holdout in this version.

`train()` writes a JSON file in ignored `data/` named from a short SHA-256 digest of the bbox. It saves the prediction, holdout MAE, training-through date and sample counts, **not** Keras weights. `GET /api/overview` exposes that JSON only if its `trained_through` date matches the latest covered day and that day is recent. The dashboard then shows the forecast beside the separate statistical activity label. If the history requirement is unmet, training fails without writing a forecast.

For a more defensible future model, compare against a persistence or seasonal baseline, test on a later untouched interval, account for seasonal and regional differences, and evaluate changes in satellite coverage. Ground-truth fire outcomes would be needed to train a true fire-risk classifier.

## 8. File-by-file guide

| File | Responsibility and important logic |
| --- | --- |
| `.env.example` | Template for `FIRMS_MAP_KEY` and optional `EARTHFIRE_DB`; contains no live secret. |
| `.gitignore` | Excludes `.env`, new local database files, virtual environments, installed packages, render builds and caches. The committed SQLite snapshot remains tracked. |
| `frontend/.prettierrc.json` | Frontend code formatting preferences. |
| `README.md` | Quick start, project layout, preview, backfill command and main scientific limits. |
| `frontend/package.json` | Frontend dependencies and `dev`, `build`, `preview`, `format`, `format:check` commands. |
| `frontend/package-lock.json` | Exact resolved npm dependency tree for repeatable installs. |
| `frontend/tsconfig.json` | Strict TypeScript, React JSX, browser libraries and no-emission type checking. |
| `frontend/vite.config.ts` | React plugin and development `/api` proxy to FastAPI on port 8000. |
| `frontend/index.html` | Root DOM node, browser metadata, font links and module entry. |
| `frontend/src/main.tsx` | Mounts the React app and imports styles. |
| `frontend/src/App.tsx` | Dashboard state, API calls, region presets, metrics, calendar, layer controls, SVG charts, status and forecast display. |
| `frontend/src/Globe.tsx` | Three.js scene, map outlines, markers, region focus, pointer rotation, resize and cleanup. |
| `frontend/src/style.css` | Responsive dashboard appearance and interaction states. |
| `backend/__init__.py`, `backend/app/__init__.py` | Mark Python packages for `python -m backend...` imports. |
| `backend/requirements.txt` | Core API/runtime Python packages. |
| `backend/requirements-ml.txt` | Optional TensorFlow dependency for training. |
| `backend/app/core.py` | `.env` loading, NASA CSV retrieval/parsing, SQLite schema, daily grid, density, FRP proxy and statistical activity calculation. |
| `backend/app/main.py` | FastAPI routes, input validation, error responses, CORS and saved-forecast freshness check. |
| `backend/backfill.py` | CLI importer that calls the FIRMS API in five-day chunks. |
| `backend/train_lstm.py` | Optional TensorFlow/Keras training, chronological holdout, next-day prediction and JSON artifact. |
| `data/earthfire.sqlite3` | Committed snapshot of NASA FIRMS observations for local exploration. |
| `data/README.md` | Explains the committed SQLite snapshot. |
| `docs/earthfire-walkthrough.mp4` | Shareable illustrated website walkthrough. |
| `docs/earthfire-walkthrough-poster.png` | Preview thumbnail linked to the video in README. |
| `docs/EarthFire-website-overview.pptx` | Six-slide editable presentation explaining the website with stills from the walkthrough. |
| `docs/PROJECT_DOCUMENTATION.md` | This detailed technical and user guide. |

The committed `data/earthfire.sqlite3` is a snapshot. Backend syncs can update this tracked database in a local checkout. `data/forecast-*.json` files are ignored and generated only after successful training. The real map key is not published in this repository.

### Function and configuration details

**Backend data path.** In `core.py`, `connect()` initializes schema and WAL mode; `parse_rows()` validates and normalizes CSV; `ingest()` fetches and persists each chosen source; `cell_key()` assigns integer grid indexes; `cell_area_km2()` computes the spherical cell-area estimate; `summarize()` produces cell and daily responses; and `statistical_risk()` computes the relative activity signal. In `main.py`, `valid_bbox()` rejects reversed or out-of-range coordinates, `health()` checks local readiness, `overview()` builds the dashboard response and conditionally loads a fresh forecast, and `ingest_route()` validates and calls NASA ingestion. `backfill.py` is a command-line wrapper around `ingest()`.

**Forecast path.** In `train_lstm.py`, `artifact_path()` maps a region to a stable local JSON filename, `fit_lstm()` constructs 14-day windows and trains/evaluates the model, and `train()` retrieves the latest uninterrupted covered series and saves a forecast. The `__main__` block parses `--bbox` and `--epochs`. `backend/requirements-ml.txt` is deliberately separate so users who only run the website do not download TensorFlow.

**Dashboard path.** In `App.tsx`, `Sparkline()` draws metric-card mini charts, `TrendChart()` draws three daily polylines, `load()` retrieves overview/health data, and `sync()` requests new FIRMS data. React state determines which region, UTC day, sensor layer and trend metric is visible. The chart and calendar are rendered from the API's `series`; the globe receives only cells from the selected day. In `Globe.tsx`, `xyz()` converts latitude/longitude to a sphere point, while its effects build the WebGL scene, refresh markers when points change, and clean up browser resources.

**Frontend configuration.** The files under `frontend/` include `package.json` for runtime and development packages and npm scripts. `package-lock.json` pins the installed dependency graph. `tsconfig.json` enables strict browser/React checking with `noEmit`; Vite performs the JavaScript build. `vite.config.ts` loads the React plugin and forwards `/api` requests to port 8000. `.prettierrc.json` sets single quotes, no semicolons, trailing commas and 100-character line width. These files do not hold the NASA key.

**Walkthrough files.** The MP4 and poster in `docs/` are documentation assets, not inputs to the fire model. The PowerPoint file uses unique stills from the video and editable slide headings; its stills are illustrative UI renders.

## 9. Known limits and next steps

- Sensor coverage, clouds, overpass timing, confidence categories and source lifecycle can affect counts. A detection is a thermal anomaly, not a confirmed fire perimeter.
- The fixed 0.5° grid is simple and transparent but cells have different areas by latitude; the current globe plots centers, not full polygons.
- Coverage is recorded for an exact bbox. Detections are shared in one database, so querying an overlapping but unfetched bbox can show observations without a matching coverage record.
- The live source list includes S-NPP as of this version; recheck NASA availability and revise it when the source ends or changes.
- The API has no authentication or per-user rate limit. Add both before hosting public ingestion with a private FIRMS key.
- The LSTM is optional and remains untrained until a continuous dataset is imported. A sparse recent demo should display the statistical status as insufficient rather than invent a forecast.

## 10. Primary references

- [NASA FIRMS Area API](https://firms.modaps.eosdis.nasa.gov/api/area/): endpoint shape, bounding box, date and 1–5 day range.
- [NASA FIRMS Map Key](https://firms.modaps.eosdis.nasa.gov/api/map_key/): free key and access rules.
- [NASA FIRMS Data Availability](https://firms.modaps.eosdis.nasa.gov/api/data_availability/): available source/date ranges.
- [NASA FIRMS API tutorial](https://firms.modaps.eosdis.nasa.gov/content/academy/data_api/firms_api_use.html): Python examples and NRT/SP distinction.
- [NASA FIRMS Active Fire Data](https://firms.modaps.eosdis.nasa.gov/active_fire/): archive and science-quality guidance.
- [TensorFlow installation guide](https://www.tensorflow.org/install/pip): supported Python/platform combinations for the optional LSTM.
- [EarthFire source code](https://github.com/ehasanulhaque152/EarthFire): implementation described here.
