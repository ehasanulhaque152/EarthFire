import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  ChevronDown,
  CircleHelp,
  Flame,
  Globe2,
  Layers3,
  MapPin,
  Radio,
  RefreshCw,
  Satellite,
  ShieldAlert,
} from 'lucide-react'
import Globe, { type Point } from './Globe'

type Cell = {
  day: string
  lat: number
  lon: number
  area_km2: number
  modis_count: number
  viirs_count: number
  modis_frp: number
  viirs_frp: number
  occupied: number
  density: number
  harmonized_frp: number
}
type Day = {
  day: string
  modis_count: number
  viirs_count: number
  modis_frp: number
  viirs_frp: number
  occupied_cells: number
  covered_sources: number
}
type Overview = {
  cells: Cell[]
  series: Day[]
  total_detections: number
  updated_at: string | null
  risk: { level: string; score: number; trend: string; model: string; message: string }
  forecast?: {
    forecast_next_day_cells: number
    holdout_mae_cells: number
    trained_through: string
  } | null
  method: {
    grid_degrees: number
    harmonized_count: string
    harmonized_frp: string
    density: string
  }
}
type Layer = 'HARMONIZED' | 'MODIS' | 'VIIRS'
const regions = {
  Bangladesh: [88, 20, 93, 27],
  'North America': [-130, 20, -60, 55],
  'South America': [-82, -56, -34, 14],
  Europe: [-12, 34, 45, 72],
  'South Asia': [60, 5, 105, 38],
  Australia: [112, -44, 154, -10],
} as const
const nf = new Intl.NumberFormat('en-US')
const dayString = (d: Date) => d.toISOString().slice(0, 10)
const today = () => dayString(new Date())

function Sparkline({ values, color = '#ff7859' }: { values: number[]; color?: string }) {
  const max = Math.max(1, ...values),
    min = Math.min(0, ...values),
    points = values
      .map(
        (v, i) =>
          `${(i * 100) / Math.max(1, values.length - 1)},${39 - ((v - min) / (max - min || 1)) * 33}`,
      )
      .join(' ')
  return (
    <svg viewBox="0 0 100 42" preserveAspectRatio="none" className="spark">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
function TrendChart({ series, metric }: { series: Day[]; metric: 'count' | 'frp' }) {
  const a = series.map((d) => (metric === 'count' ? d.modis_count : d.modis_frp)),
    b = series.map((d) => (metric === 'count' ? d.viirs_count : d.viirs_frp)),
    c = series.map((d) =>
      metric === 'count' ? d.occupied_cells : Math.max(d.modis_frp, d.viirs_frp),
    )
  const max = Math.max(1, ...a, ...b, ...c),
    n = Math.max(1, series.length - 1)
  const line = (arr: number[]) =>
    arr.map((v, i) => `${30 + (i * 670) / n},${163 - (v / max) * 133}`).join(' ')
  return (
    <div className="chart-wrap">
      <svg
        viewBox="0 0 720 200"
        preserveAspectRatio="none"
        role="img"
        aria-label="Daily MODIS, VIIRS and harmonized trend chart"
      >
        {[0, 1, 2, 3].map((i) => (
          <g key={i}>
            <line
              x1="30"
              x2="700"
              y1={30 + i * 44.3}
              y2={30 + i * 44.3}
              stroke="#20333b"
              strokeDasharray="3 6"
            />
            <text x="0" y={34 + i * 44.3} fill="#718892" fontSize="10">
              {Math.round(max * (1 - i / 3))}
            </text>
          </g>
        ))}
        <polyline
          points={line(a)}
          fill="none"
          stroke="#f9a85e"
          strokeWidth="2.2"
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          points={line(b)}
          fill="none"
          stroke="#51c7ca"
          strokeWidth="2.2"
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          points={line(c)}
          fill="none"
          stroke="#ff7056"
          strokeWidth="2.6"
          vectorEffect="non-scaling-stroke"
        />
        {series.length > 0 &&
          [0, Math.floor(n / 2), n].map((i) => (
            <text
              key={i}
              x={30 + (i * 670) / n}
              y="191"
              textAnchor={i === 0 ? 'start' : i === n ? 'end' : 'middle'}
              fill="#728993"
              fontSize="10"
            >
              {series[i]?.day.slice(5)}
            </text>
          ))}
      </svg>
    </div>
  )
}

export default function App() {
  const [region, setRegion] = useState<keyof typeof regions>('Bangladesh')
  const [layer, setLayer] = useState<Layer>('HARMONIZED')
  const [metric, setMetric] = useState<'count' | 'frp'>('count')
  const [selectedDay, setSelectedDay] = useState(today())
  const [data, setData] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState('')
  const [backendReady, setBackendReady] = useState(false)
  const [configured, setConfigured] = useState(false)
  const [calendarOpen, setCalendarOpen] = useState(false)
  const bbox = regions[region]
  async function load() {
    setLoading(true)
    try {
      const end = today(),
        start = dayString(new Date(Date.now() - 29 * 86400000))
      const params = new URLSearchParams({
        west: String(bbox[0]),
        south: String(bbox[1]),
        east: String(bbox[2]),
        north: String(bbox[3]),
        start,
        end,
      })
      const response = await fetch(`/api/overview?${params}`)
      if (!response.ok) throw Error('API unavailable')
      const overview: Overview = await response.json()
      setData(overview)
      setBackendReady(true)
      setError('')
      const latestActive = [...overview.series].reverse().find((d) => d.occupied_cells > 0)
      if (latestActive) setSelectedDay(latestActive.day)
      const health = await fetch('/api/health').then((r) => r.json())
      setConfigured(health.firms_configured)
    } catch {
      setBackendReady(false)
      setError('Start the FastAPI server to load FIRMS data.')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    load()
  }, [region])
  async function sync() {
    setSyncing(true)
    setError('')
    try {
      const res = await fetch('/api/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bbox, days: 3 }),
      })
      const body = await res.json()
      if (!res.ok) throw Error(body.detail || 'FIRMS sync failed')
      await load()
      setSelectedDay(today())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSyncing(false)
    }
  }
  const cells = data?.cells.filter((c) => c.day === selectedDay) || []
  const points: Point[] = useMemo(
    () =>
      cells
        .filter(
          (c) => layer === 'HARMONIZED' || (layer === 'MODIS' ? c.modis_count : c.viirs_count) > 0,
        )
        .map((c) => ({
          lat: c.lat,
          lon: c.lon,
          value:
            layer === 'MODIS'
              ? c.modis_count
              : layer === 'VIIRS'
                ? c.viirs_count
                : c.modis_count + c.viirs_count,
          kind: layer,
        })),
    [cells, layer],
  )
  const daily = data?.series.find((d) => d.day === selectedDay)
  const total = data?.series.reduce((s, d) => s + d.modis_count + d.viirs_count, 0) || 0
  const activeDays = data?.series.filter((d) => d.occupied_cells > 0).length || 0
  const coveredDays = data?.series.filter((d) => d.covered_sources >= 2).length || 0
  const occupied = data?.series.reduce((s, d) => s + d.occupied_cells, 0) || 0
  const frp = data?.series.reduce((s, d) => s + d.modis_frp + d.viirs_frp, 0) || 0
  const lastSync = data?.updated_at
    ? new Date(data.updated_at).toLocaleString()
    : 'Awaiting first sync'
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">
            <Flame size={21} fill="currentColor" />
          </div>
          <span>
            earth<span className="brand-accent">fire</span>
            <small>INTELLIGENCE PLATFORM</small>
          </span>
        </div>
        <div className="sidebar-label">WORKSPACE</div>
        <nav>
          <a className="nav-item active">
            <Globe2 size={18} /> Overview <span className="nav-indicator" />
          </a>
          <a className="nav-item" href="#analytics">
            <Activity size={18} /> Analytics
          </a>
          <a className="nav-item" href="#method">
            <Layers3 size={18} /> Methodology
          </a>
        </nav>
        <div className="sidebar-divider" />
        <div className="sidebar-label">DATA SOURCES</div>
        <div className="source-item">
          <span className="source-dot modis" /> MODIS <span>1 km</span>
        </div>
        <div className="source-item">
          <span className="source-dot viirs" /> VIIRS <span>375 m</span>
        </div>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <Satellite size={20} />
            <strong>Powered by NASA FIRMS</strong>
            <p>Near real time active fire detections from orbit.</p>
          </div>
          <div className="version">EARTHFIRE / V0.1</div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            Platform <span>/</span> <b>Overview</b>
          </div>
          <div className="top-actions">
            <span className={'connection ' + (backendReady ? 'online' : 'offline')}>
              <span /> {backendReady ? 'API connected' : 'API offline'}
            </span>
            <a
              className="help-link"
              href="https://firms.modaps.eosdis.nasa.gov/api/"
              target="_blank"
              rel="noreferrer"
            >
              <CircleHelp size={17} /> FIRMS docs
            </a>
          </div>
        </header>
        <div className="content">
          <div className="page-title">
            <div>
              <div className="eyebrow">
                <span className="eyebrow-line" /> EARTH OBSERVATION / ACTIVE FIRES
              </div>
              <h1>
                Fire intelligence, <em>from orbit.</em>
              </h1>
              <p>Explore where MODIS and VIIRS agree, and how fire activity evolves over time.</p>
            </div>
            <button
              className="sync-button"
              disabled={syncing || !backendReady || !configured}
              onClick={sync}
            >
              <RefreshCw size={16} className={syncing ? 'spinning' : ''} />
              {syncing ? 'Syncing FIRMS…' : 'Sync latest data'}
            </button>
          </div>
          {error && (
            <div className="alert">
              <ShieldAlert size={17} />
              {error}
            </div>
          )}
          {!configured && backendReady && (
            <div className="alert muted">
              <CircleHelp size={17} /> Add FIRMS_MAP_KEY to .env, then restart the API to enable
              live sync.
            </div>
          )}
          <div className="toolbar">
            <div className="region-select">
              <MapPin size={17} />
              <select
                value={region}
                onChange={(e) => setRegion(e.target.value as keyof typeof regions)}
              >
                {Object.keys(regions).map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
              <ChevronDown size={15} />
            </div>
            <span className="toolbar-separator" />
            <div className="date-control">
              <CalendarDays size={17} />
              <input
                type="date"
                value={selectedDay}
                min={data?.series[0]?.day}
                max={today()}
                onChange={(e) => setSelectedDay(e.target.value)}
              />
            </div>
            <span className="toolbar-spacer" />
            <div className="freshness">
              <Radio size={15} /> {coveredDays}/30 days synced · Updated: {lastSync}
            </div>
          </div>
          <section className="metrics">
            <div className="metric-card">
              <div className="metric-heading">
                Total detections <Flame size={17} />
              </div>
              <div className="metric-number">{nf.format(total)}</div>
              <div className="metric-foot">MODIS + VIIRS · {coveredDays} synced days</div>
              <Sparkline values={data?.series.map((d) => d.modis_count + d.viirs_count) || []} />
            </div>
            <div className="metric-card">
              <div className="metric-heading">
                Occupied grid cells <Layers3 size={17} />
              </div>
              <div className="metric-number">{nf.format(occupied)}</div>
              <div className="metric-foot">0.5° daily cells, harmonized</div>
              <Sparkline values={data?.series.map((d) => d.occupied_cells) || []} color="#51c7ca" />
            </div>
            <div className="metric-card">
              <div className="metric-heading">
                Sensor FRP <Activity size={17} />
              </div>
              <div className="metric-number">
                {frp ? nf.format(Math.round(frp)) : '0'} <small>MW</small>
              </div>
              <div className="metric-foot">Sum of sensor observations</div>
              <Sparkline
                values={data?.series.map((d) => d.modis_frp + d.viirs_frp) || []}
                color="#f9a85e"
              />
            </div>
            <div className="metric-card risk-card">
              <div className="metric-heading">
                {data?.forecast ? 'Statistical + LSTM' : 'Activity signal'}{' '}
                <ShieldAlert size={17} />
              </div>
              <div className="risk-value">{data?.risk.level || 'unknown'}</div>
              <div className="metric-foot">
                {data?.forecast ? (
                  `LSTM next day: ${data.forecast.forecast_next_day_cells} cells · MAE ${data.forecast.holdout_mae_cells}`
                ) : (
                  <>
                    {data?.risk.trend === 'rising' ? (
                      <ArrowUpRight size={14} />
                    ) : (
                      <ArrowDownRight size={14} />
                    )}{' '}
                    {data?.risk.message || 'Awaiting history'}
                  </>
                )}
              </div>
              <div className="risk-meter">
                <span style={{ width: `${data?.risk.score || 0}%` }} />
              </div>
            </div>
          </section>
          <div className="primary-grid">
            <section className="panel globe-panel">
              <div className="panel-header">
                <div>
                  <div className="panel-kicker">GEOSPATIAL VIEW</div>
                  <h2>Global fire activity</h2>
                </div>
                <span className="live-badge">
                  <span /> UTC {selectedDay}
                </span>
              </div>
              <div className="globe-wrap">
                <div className="globe-aura" />
                <Globe
                  key={region}
                  points={points}
                  focus={[(bbox[1] + bbox[3]) / 2, (bbox[0] + bbox[2]) / 2]}
                />
                <div className="globe-top-label">
                  SATELLITE OBSERVATIONS <span>•</span> {region.toUpperCase()}
                </div>
                <div className="globe-bottom-label">
                  DRAG TO ROTATE <span>·</span> {points.length} ACTIVE CELLS
                </div>
              </div>
              <div className="layer-row">
                <div className="layer-switch">
                  {(['HARMONIZED', 'MODIS', 'VIIRS'] as Layer[]).map((l) => (
                    <button
                      key={l}
                      className={layer === l ? 'selected ' + l.toLowerCase() : ''}
                      onClick={() => setLayer(l)}
                    >
                      <span className={'layer-dot ' + l.toLowerCase()} />
                      {l === 'HARMONIZED' ? 'Harmonized' : l}
                    </button>
                  ))}
                </div>
                <div className="map-scale">
                  <span /> LOW <i /> HIGH
                </div>
              </div>
            </section>
            <section className="panel side-panel">
              <div className="panel-header">
                <div>
                  <div className="panel-kicker">DAILY SNAPSHOT</div>
                  <h2>Fire calendar</h2>
                </div>
                <CalendarDays size={18} className="dim-icon" />
              </div>
              <div className="calendar-head">
                <button onClick={() => setCalendarOpen(!calendarOpen)}>
                  {new Date(selectedDay + 'T12:00:00Z').toLocaleString('en-US', {
                    month: 'long',
                    year: 'numeric',
                    timeZone: 'UTC',
                  })}{' '}
                  <ChevronDown size={15} />
                </button>
                <span>UTC</span>
              </div>
              <div className="calendar-grid">
                {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
                  <div className="weekday" key={i}>
                    {d}
                  </div>
                ))}
                {(() => {
                  const date = new Date(selectedDay + 'T12:00:00Z'),
                    year = date.getUTCFullYear(),
                    month = date.getUTCMonth(),
                    offset = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7,
                    days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
                  return [...Array(offset)]
                    .map((_, i) => <div key={'e' + i} />)
                    .concat(
                      [...Array(days)].map((_, i) => {
                        const iso = dayString(new Date(Date.UTC(year, month, i + 1))),
                          entry = data?.series.find((d) => d.day === iso),
                          hot = !!entry?.occupied_cells
                        return (
                          <button
                            key={iso}
                            className={
                              (iso === selectedDay ? 'selected ' : '') + (hot ? 'has-fire' : '')
                            }
                            disabled={iso > today()}
                            onClick={() => setSelectedDay(iso)}
                          >
                            {i + 1}
                          </button>
                        )
                      }),
                    )
                })()}
              </div>
              {calendarOpen && (
                <div className="calendar-hint">Choose a day to update the globe and snapshot.</div>
              )}
              <div className="snapshot-divider" />
              <div className="snapshot-title">
                {new Date(selectedDay + 'T12:00:00Z').toLocaleString('en-US', {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                  timeZone: 'UTC',
                })}
              </div>
              <div className="snapshot-row">
                <span>
                  <i className="source-dot modis" /> MODIS detections
                </span>
                <b>{nf.format(daily?.modis_count || 0)}</b>
              </div>
              <div className="snapshot-row">
                <span>
                  <i className="source-dot viirs" /> VIIRS detections
                </span>
                <b>{nf.format(daily?.viirs_count || 0)}</b>
              </div>
              <div className="snapshot-row">
                <span>
                  <i className="source-dot harmonized" /> Occupied cells
                </span>
                <b>{nf.format(daily?.occupied_cells || 0)}</b>
              </div>
              <div className="snapshot-cta">
                {activeDays} days with detections in this 30-day window <ArrowRight size={15} />
              </div>
            </section>
          </div>
          <div className="lower-grid" id="analytics">
            <section className="panel trends-panel">
              <div className="panel-header">
                <div>
                  <div className="panel-kicker">HISTORICAL ANALYSIS</div>
                  <h2>Activity over time</h2>
                </div>
                <div className="metric-toggle">
                  <button
                    className={metric === 'count' ? 'active' : ''}
                    onClick={() => setMetric('count')}
                  >
                    Detections
                  </button>
                  <button
                    className={metric === 'frp' ? 'active' : ''}
                    onClick={() => setMetric('frp')}
                  >
                    FRP
                  </button>
                </div>
              </div>
              <TrendChart series={data?.series || []} metric={metric} />
              <div className="chart-legend">
                <span>
                  <i className="legend-line modis" />
                  MODIS
                </span>
                <span>
                  <i className="legend-line viirs" />
                  VIIRS
                </span>
                <span>
                  <i className="legend-line harmonized" />
                  Harmonized{metric === 'frp' ? ' proxy' : ''}
                </span>
              </div>
            </section>
            <section className="panel method-panel" id="method">
              <div className="panel-kicker">THE METHOD</div>
              <h2>One grid. Two sensors.</h2>
              <p>
                MODIS and VIIRS detect fires at different resolutions. EarthFire places both on the
                same 0.5° daily grid, so you can compare sensor activity without treating each
                hotspot as an equal area.
              </p>
              <div className="method-flow">
                <span>
                  MODIS <small>1 km</small>
                </span>
                <span>+</span>
                <span>
                  VIIRS <small>375 m</small>
                </span>
                <ArrowRight size={16} />
                <span className="flow-result">DAILY GRID</span>
              </div>
              <div className="method-note">
                <CircleHelp size={16} /> Occupied cells are an activity indicator, not a calibrated
                fire count or fire probability.
              </div>
            </section>
          </div>
          <footer>
            <span>EARTHFIRE · NASA FIRMS DATA EXPLORER</span>
            <span>UTC dates · Experimental harmonization · Not for emergency response</span>
          </footer>
        </div>
      </main>
    </div>
  )
}
