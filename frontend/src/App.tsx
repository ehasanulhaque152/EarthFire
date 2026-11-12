import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  Bookmark,
  Bell,
  Download,
  Pause,
  Play,
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
  Search,
  Satellite,
  ShieldAlert,
  X,
} from 'lucide-react'
import Globe, { countryBounds, countryCenter, countryNames, type Point } from './Globe'

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
  harmonized_frp: number
  occupied_cells: number
  covered_sources: number
}
type Overview = {
  cells: Cell[]
  series: Day[]
  total_detections: number
  updated_at: string | null
  risk: { level: string; score: number; trend: string; model: string; message: string }
  prediction?: {
    forecast_for: string
    forecast_through: string
    forecast_next_day_cells: number
    backtest_mae_cells: number
    training_days: number
    model: string
  } | null
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

function continentForCountry(name: string) {
  const center = countryCenter(name)
  if (!center) return null
  const [lat, lon] = center
  if (lat < -60) return 'Antarctica'
  // Use the country's largest land polygon center for a practical continent label.
  if (lon >= -20 && lon <= 55 && lat >= -35 && lat <= 38) return 'Africa'
  if (lon >= -85 && lon <= -30 && lat >= -60 && lat < 15) return 'South America'
  if (lon < -30 && lat >= 7) return 'North America'
  if (lon >= 130 && lon <= 180 && lat < 0) return 'Oceania'
  if (lon >= -25 && lon < 60 && lat >= 35 && lat <= 75) return 'Europe'
  if (lon >= 25 && lon <= 180 && lat >= -10 && lat <= 80) return 'Asia'
  if (lon >= 110 && lon <= 180 && lat < 0) return 'Oceania'
  return null
}

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
      metric === 'count' ? d.occupied_cells : d.harmonized_frp,
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
  const [selectedFire, setSelectedFire] = useState<Point | null>(null)
  const [countryQuery, setCountryQuery] = useState('')
  const [searchedCountry, setSearchedCountry] = useState<[number, number] | null>(null)
  const [searchedCountryName, setSearchedCountryName] = useState('')
  const [searchedCountryData, setSearchedCountryData] = useState<Overview | null>(null)
  const [countryLoading, setCountryLoading] = useState(false)
  const [countryRefreshing, setCountryRefreshing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState('')
  const [backendReady, setBackendReady] = useState(false)
  const [configured, setConfigured] = useState(false)
  const [calendarMonth, setCalendarMonth] = useState(today().slice(0, 7))
  const [calendarData, setCalendarData] = useState<Overview | null>(null)
  const [calendarLoading, setCalendarLoading] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [followedRegions, setFollowedRegions] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('earthfire-followed-regions') || '[]') as string[] } catch { return [] }
  })
  const followedRegionsRef = useRef(followedRegions)
  followedRegionsRef.current = followedRegions
  const [alertsEnabled, setAlertsEnabled] = useState(() => typeof Notification !== 'undefined' && Notification.permission === 'granted')
  const historyRequest = useRef(0)
  const countryRequest = useRef(0)
  const syncInFlight = useRef(false)
  const dataRef = useRef<Overview | null>(null)
  const bbox = regions[region]
  useEffect(() => {
    setCountryQuery('')
    setSearchedCountry(null)
    setSearchedCountryName('')
    setSearchedCountryData(null)
  }, [region])
  function focusCountry(query: string) {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return
    const country =
      countryNames.find((name) => name.toLocaleLowerCase() === normalized) ||
      countryNames.find((name) => name.toLocaleLowerCase().startsWith(normalized))
    if (!country) return
    const center = countryCenter(country)
    if (center) {
      setCountryQuery(country)
      setSearchedCountry(center)
      setSearchedCountryName(country)
    }
  }
  useEffect(() => {
    if (!searchedCountryName) {
      setSearchedCountryData(null)
      return
    }
    const bounds = countryBounds(searchedCountryName)
    if (!bounds) return
    const requestId = ++countryRequest.current
    const controller = new AbortController()
    const loadCountry = async () => {
      setCountryLoading(true)
      setCountryRefreshing(false)
      setSearchedCountryData(null)
      try {
        const health = await fetch('/api/health', { signal: controller.signal }).then((response) => response.json())
        const end = health.firms_configured ? today() : (health.latest_observation_day || today())
        const start = dayString(new Date(Date.parse(`${end}T00:00:00Z`) - 29 * 86400000))
        const loadOverview = async () => {
          const params = new URLSearchParams({
            west: String(bounds[0]), south: String(bounds[1]),
            east: String(bounds[2]), north: String(bounds[3]), start, end,
          })
          const response = await fetch(`/api/overview?${params}`, { signal: controller.signal })
          if (!response.ok) throw Error('Could not load hotspots for this country')
          return response.json() as Promise<Overview>
        }
        const overview = await loadOverview()
        if (requestId !== countryRequest.current) return
        setSearchedCountryData(overview)
        const latestHotspotDay = [...overview.series].reverse().find((day) => day.occupied_cells > 0)?.day
        if (latestHotspotDay) setSelectedDay(latestHotspotDay)
        setCountryLoading(false)

        if (health.firms_configured) {
          setCountryRefreshing(true)
          const syncResponse = await fetch('/api/ingest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bbox: bounds, days: 3 }),
            signal: controller.signal,
          })
          if (syncResponse.ok && requestId === countryRequest.current) {
            const refreshedOverview = await loadOverview()
            if (requestId !== countryRequest.current) return
            setSearchedCountryData(refreshedOverview)
            const refreshedDay = [...refreshedOverview.series].reverse().find((day) => day.occupied_cells > 0)?.day
            if (refreshedDay) setSelectedDay(refreshedDay)
          }
        }
      } catch (cause) {
        if (!controller.signal.aborted && requestId === countryRequest.current) {
          setError((cause as Error).message || 'Could not load country hotspots')
        }
      } finally {
        if (requestId === countryRequest.current) {
          setCountryLoading(false)
          setCountryRefreshing(false)
        }
      }
    }
    void loadCountry()
    return () => controller.abort()
  }, [searchedCountryName])
  async function load() {
    setLoading(true)
    try {
      const health = await fetch('/api/health').then((r) => {
        if (!r.ok) throw Error('API unavailable')
        return r.json()
      })
      let end = !health.firms_configured && health.latest_observation_day
          ? health.latest_observation_day
          : today(),
        start = dayString(new Date(Date.parse(`${end}T00:00:00Z`) - 29 * 86400000))
      const params = new URLSearchParams({
        west: String(bbox[0]),
        south: String(bbox[1]),
        east: String(bbox[2]),
        north: String(bbox[3]),
        start,
        end,
      })
      let response = await fetch(`/api/overview?${params}`)
      if (!response.ok) throw Error('API unavailable')
      let overview: Overview = await response.json()
      let showingSavedSnapshot = false
      if (
        overview.total_detections === 0 &&
        health.latest_observation_day &&
        health.latest_observation_day < start
      ) {
        end = health.latest_observation_day
        const snapshotStart = dayString(new Date(Date.parse(`${end}T00:00:00Z`) - 29 * 86400000))
        params.set('start', snapshotStart)
        params.set('end', end)
        response = await fetch(`/api/overview?${params}`)
        if (!response.ok) throw Error('API unavailable')
        overview = await response.json()
        showingSavedSnapshot = true
      }
      dataRef.current = overview
      setData(overview)
      setCalendarData(overview)
      setBackendReady(true)
      setError(
        showingSavedSnapshot
          ? `Showing the saved NASA snapshot through ${end}; live sync has not added newer observations.`
          : '',
      )
      const latestActive = [...overview.series].reverse().find((d) => d.occupied_cells > 0)
      const initialDay = latestActive?.day || end
      setCalendarMonth(initialDay.slice(0, 7))
      if (latestActive) setSelectedDay(latestActive.day)
      else if (showingSavedSnapshot) setSelectedDay(end)
      setConfigured(health.firms_configured)
      return true
    } catch {
      setBackendReady(false)
      setError('Waiting for EarthFire data service. Reconnecting…')
      return false
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    let cancelled = false
    let retryTimer: number | undefined
    const connect = async (attempt: number) => {
      const ready = await load()
      if (!ready && !cancelled && attempt < 8) {
        retryTimer = window.setTimeout(() => void connect(attempt + 1), 10_000)
      }
    }
    void connect(0)
    return () => {
      cancelled = true
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
    }
  }, [region])
  async function sync() {
    if (syncInFlight.current) return
    syncInFlight.current = true
    setSyncing(true)
    setError('')
    try {
      const res = await fetch('/api/ingest/recent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bbox }),
      })
      const body = await res.json()
      if (!res.ok) throw Error(body.detail || 'FIRMS sync failed')
      const previousDetections = dataRef.current?.total_detections || 0
      await load()
      const alertKey = `earthfire-alert-${region}-${today()}`
      const currentDetections = dataRef.current?.total_detections || 0
      if (currentDetections > previousDetections && followedRegionsRef.current.includes(region) && typeof Notification !== 'undefined' && Notification.permission === 'granted' && localStorage.getItem(alertKey) !== 'sent') {
        new Notification(`New EarthFire hotspots · ${region}`, { body: `${currentDetections - previousDetections} detections were added to the current 30-day view.` })
        localStorage.setItem(alertKey, 'sent')
      }
      setSelectedFire(null)
      setSelectedDay(today())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      syncInFlight.current = false
      setSyncing(false)
    }
  }
  useEffect(() => {
    if (!backendReady || !configured) return
    const initialSync = window.setTimeout(() => void sync(), 1500)
    const refresh = window.setInterval(() => void sync(), 11 * 60 * 1000)
    return () => {
      window.clearTimeout(initialSync)
      window.clearInterval(refresh)
    }
  }, [backendReady, configured, region])
  async function loadCalendarMonth(monthKey: string, requestedDay?: string) {
    setCalendarMonth(monthKey)
    const requestId = ++historyRequest.current
    const [year, month] = monthKey.split('-').map(Number)
    setCalendarLoading(true)
    setError('')
    try {
      const response = await fetch('/api/history/month', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bbox, year, month }),
      })
      const body = await response.json()
      if (!response.ok) throw Error(body.detail || 'Could not load fire history')
      if (requestId !== historyRequest.current) return
      setCalendarData(body)
      setSelectedFire(null)
      const lastDay = `${monthKey}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`
      const chosenDay = requestedDay?.slice(0, 7) === monthKey ? requestedDay : lastDay
      setSelectedDay(chosenDay > body.end ? body.end : chosenDay)
    } catch (e) {
      if (requestId === historyRequest.current) setError((e as Error).message)
    } finally {
      if (requestId === historyRequest.current) setCalendarLoading(false)
    }
  }
  const calendarSeries = calendarData?.series || data?.series || []
  const timelineDays = calendarSeries.map((d) => d.day).filter((d) => d <= today())
  const selectedTimelineIndex = Math.max(0, timelineDays.indexOf(selectedDay))
  useEffect(() => {
    if (!playing || timelineDays.length < 2) return
    const timer = window.setInterval(() => {
      setSelectedFire(null)
      setSelectedDay((current) => {
        const index = timelineDays.indexOf(current)
        return timelineDays[index < 0 ? 0 : (index + 1) % timelineDays.length]
      })
    }, 900)
    return () => window.clearInterval(timer)
  }, [playing, timelineDays.join('|')])
  function toggleFollow() {
    const next = followedRegions.includes(region) ? followedRegions.filter((item) => item !== region) : [...followedRegions, region]
    setFollowedRegions(next)
    localStorage.setItem('earthfire-followed-regions', JSON.stringify(next))
  }
  async function enableAlerts() {
    if (typeof Notification === 'undefined') { setError('Browser notifications are not supported here.'); return }
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
    setAlertsEnabled(permission === 'granted')
    if (permission !== 'granted') setError('Allow notifications in your browser settings to receive hotspot alerts.')
  }
  function downloadCsv() {
    const rows = (calendarData || data)?.cells || []
    const columns: (keyof Cell)[] = ['day','lat','lon','area_km2','modis_count','viirs_count','modis_frp','viirs_frp','occupied','density','harmonized_frp']
    const csv = [columns.join(','), ...rows.map((row) => columns.map((key) => String(row[key] ?? '')).join(','))].join('\\n')
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); link.download = `earthfire-${region.toLowerCase().replaceAll(' ', '-')}-${calendarMonth}.csv`; link.click(); window.setTimeout(() => URL.revokeObjectURL(link.href), 1000)
  }
  function downloadChart() {
    const svg = document.querySelector('.trends-panel .chart-wrap svg')
    if (!svg) return
    const copy = svg.cloneNode(true) as SVGSVGElement
    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: 'image/svg+xml' })); link.download = `earthfire-${region.toLowerCase().replaceAll(' ', '-')}-chart.svg`; link.click(); window.setTimeout(() => URL.revokeObjectURL(link.href), 1000)
  }
  const activeOverview = searchedCountryName ? searchedCountryData : (calendarData || data)
  const cells = activeOverview?.cells.filter((c) => c.day === selectedDay) || []
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
          modisCount: c.modis_count,
          viirsCount: c.viirs_count,
          modisFrp: c.modis_frp,
          viirsFrp: c.viirs_frp,
          areaKm2: c.area_km2,
          density: c.density,
        })),
    [cells, layer],
  )
  const daily = calendarSeries.find((d) => d.day === selectedDay)
  const calendarCoverage = calendarSeries.filter((d) => d.covered_sources >= 2)
  const coverageStart = calendarCoverage[0]?.day
  const coverageEnd = calendarCoverage.at(-1)?.day
  const observedTrend = (data?.series || []).filter((d) => d.covered_sources >= 2)
  const peakDay = observedTrend.reduce<Day | null>((peak, current) =>
    !peak || current.occupied_cells > peak.occupied_cells ? current : peak, null)
  const sortedCells = [...observedTrend.map((d) => d.occupied_cells)].sort((a, b) => a - b)
  const middle = Math.floor(sortedCells.length / 2)
  const typicalCells = sortedCells.length
    ? sortedCells.length % 2
      ? sortedCells[middle]
      : (sortedCells[middle - 1] + sortedCells[middle]) / 2
    : 0
  const peakAboveTypical = typicalCells > 0 && peakDay
    ? Math.round(((peakDay.occupied_cells - typicalCells) / typicalCells) * 100)
    : null
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
              <span /> {backendReady ? 'Server online' : 'Connecting…'}
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
              <p>Compare MODIS and VIIRS fire detections on a shared daily grid and explore how activity changes over time.</p>
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
                aria-label="Choose a region"
                value={region}
                onChange={(e) => {
                  setSelectedFire(null)
                  setRegion(e.target.value as keyof typeof regions)
                }}
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
                min="2000-01-01"
                max={today()}
                onChange={(e) => {
                  const value = e.target.value
                  if (value.slice(0, 7) !== calendarMonth || !calendarSeries.some((d) => d.day === value)) void loadCalendarMonth(value.slice(0, 7), value)
                  else {
                    setSelectedFire(null)
                    setSelectedDay(value)
                  }
                }}
              />
            </div>
            <span className="toolbar-spacer" />
            <div className="freshness">
              <Radio size={15} />{' '}
              {loading ? `Loading ${region}…` : `${coveredDays}/30 days synced · Updated: ${lastSync}`}
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
            <div className="metric-card prediction-card" aria-label="Experimental next-day fire activity forecast">
              <div className="metric-heading">
                Next-day outlook <Satellite size={17} />
              </div>
              <div className="metric-number">
                {data?.prediction ? nf.format(Math.round(data.prediction.forecast_next_day_cells)) : '—'}{' '}
                <small>cells</small>
              </div>
              <div className="metric-foot">
                {data?.prediction
                  ? `For ${data.prediction.forecast_for} UTC · MAE ±${data.prediction.backtest_mae_cells} cells`
                  : 'Needs 14 consecutive current days'}
              </div>
              <div className="prediction-note">
                {data?.prediction
                  ? '7-day MODIS + VIIRS grid estimate · not a fire count or probability'
                  : 'Uses complete MODIS + VIIRS coverage'}
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
                  focus={searchedCountry || [(bbox[1] + bbox[3]) / 2, (bbox[0] + bbox[2]) / 2]}
                  zoom={searchedCountry ? 5.1 : 6.5}
                  selectedPoint={selectedFire}
                  onPointSelect={setSelectedFire}
                  onCountrySelect={focusCountry}
                />
                <div className="globe-top-label">
                  SATELLITE OBSERVATIONS <span>•</span> {region.toUpperCase()}
                </div>
                <div className="globe-bottom-label">
                  DRAG TO ROTATE <span>·</span> SCROLL / PINCH TO ZOOM <span>·</span> {points.length} ACTIVE CELLS
                </div>
                {selectedFire && (
                  <section className="fire-details" aria-label="Selected fire details">
                    <div className="fire-details-heading">
                      <span><Flame size={15} /> Fire point details</span>
                      <button
                        type="button"
                        aria-label="Close fire details"
                        onClick={() => setSelectedFire(null)}
                      >
                        <X size={15} />
                      </button>
                    </div>
                    <div className="fire-detail-row"><span>Region</span><strong>{searchedCountryName ? (continentForCountry(searchedCountryName) || region) : region}</strong></div>
                    {selectedFire.country && (
                      <div className="fire-detail-row"><span>Country</span><strong>{selectedFire.country}</strong></div>
                    )}
                    <div className="fire-detail-row"><span>Observed</span><strong>{selectedDay} UTC</strong></div>
                    <div className="fire-detail-row"><span>Coordinates</span><strong>{selectedFire.lat.toFixed(2)}°, {selectedFire.lon.toFixed(2)}°</strong></div>
                    <div className="fire-detail-row"><span>MODIS</span><strong>{nf.format(selectedFire.modisCount)} · {nf.format(Math.round(selectedFire.modisFrp))} MW</strong></div>
                    <div className="fire-detail-row"><span>VIIRS</span><strong>{nf.format(selectedFire.viirsCount)} · {nf.format(Math.round(selectedFire.viirsFrp))} MW</strong></div>
                    <div className="fire-detail-row"><span>Cell area</span><strong>{nf.format(Math.round(selectedFire.areaKm2))} km²</strong></div>
                    <div className="fire-detail-row"><span>Detection density</span><strong>{selectedFire.density.toFixed(2)} / km²</strong></div>
                    <div className="fire-detail-row"><span>Combined FRP</span><strong>{nf.format(Math.round(selectedFire.modisFrp + selectedFire.viirsFrp))} MW</strong></div>
                    <p>Grid-cell center from satellite detections; not a fire perimeter.</p>
                  </section>
                )}
              </div>
              <div className="globe-search-row">
                <Search size={16} aria-hidden="true" />
                <input
                  type="search"
                  list="earthfire-country-options"
                  value={countryQuery}
                  aria-label="Search for a country on the globe"
                  placeholder="Search for a country"
                  onChange={(event) => {
                    const value = event.currentTarget.value
                    setCountryQuery(value)
                    const match = countryNames.find(
                      (name) => name.toLocaleLowerCase() === value.trim().toLocaleLowerCase(),
                    )
                    if (match) {
                      setSearchedCountry(countryCenter(match))
                      setSearchedCountryName(match)
                    } else if (!value.trim()) {
                      setSearchedCountry(null)
                      setSearchedCountryName('')
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      focusCountry(countryQuery)
                    }
                  }}
                />
                <datalist id="earthfire-country-options">
                  {countryNames.map((name) => <option key={name} value={name} />)}
                </datalist>
              </div>
              {searchedCountryName && (
                <div className="country-hotspot-status" role="status">
                  {countryLoading
                    ? `Loading hotspots for ${searchedCountryName}…`
                    : `${points.length.toLocaleString()} hotspot cells shown for ${searchedCountryName} on ${selectedDay} UTC${countryRefreshing ? ' · refreshing recent data' : ''}`}
                </div>
              )}
              <div className="layer-row">
                <div className="layer-switch">
                  {(['HARMONIZED', 'MODIS', 'VIIRS'] as Layer[]).map((l) => (
                    <button
                      key={l}
                      className={layer === l ? 'selected ' + l.toLowerCase() : ''}
                      onClick={() => {
                        setSelectedFire(null)
                        setLayer(l)
                      }}
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
              <div className="globe-tools">
                <button type="button" onClick={() => setPlaying((value) => !value)} disabled={timelineDays.length < 2}>
                  {playing ? <Pause size={14} /> : <Play size={14} />}{playing ? 'Pause' : 'Play'} timeline
                </button>
                <input aria-label="Fire timeline day" type="range" min="0" max={Math.max(0, timelineDays.length - 1)} value={selectedTimelineIndex} onChange={(e) => { setPlaying(false); setSelectedFire(null); setSelectedDay(timelineDays[Number(e.target.value)] || selectedDay) }} />
                <small>{selectedDay} · {timelineDays.length} days</small>
              </div>
              <div className="saved-area-tools">
                <button type="button" onClick={toggleFollow}><Bookmark size={14} />{followedRegions.includes(region) ? `Following ${region}` : `Follow ${region}`}</button>
                <button type="button" onClick={enableAlerts} disabled={alertsEnabled}><Bell size={14} />{alertsEnabled ? 'Alerts enabled' : 'Enable hotspot alerts'}</button>
                {followedRegions.length > 0 && <small>Saved areas: {followedRegions.join(', ')}</small>}
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
                <div className="calendar-period">
                  <select aria-label="Choose calendar month" value={Number(calendarMonth.slice(5))} disabled={calendarLoading}
                    onChange={(e) => void loadCalendarMonth(`${calendarMonth.slice(0, 4)}-${String(Number(e.target.value)).padStart(2, '0')}`)}>
                    {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                      <option key={m} value={m}>{new Date(Date.UTC(2000, m - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })}</option>
                    ))}
                  </select>
                  <select aria-label="Choose calendar year" value={Number(calendarMonth.slice(0, 4))} disabled={calendarLoading}
                    onChange={(e) => void loadCalendarMonth(`${e.target.value}-${calendarMonth.slice(5)}`)}>
                    {Array.from({ length: new Date().getUTCFullYear() - 1999 }, (_, i) => new Date().getUTCFullYear() - i).map((y) => (
                      <option key={y} value={y}>{y}</option>
                    ))}
                  </select>
                </div>
                <span>{calendarLoading ? 'Loading…' : 'UTC'}</span>
              </div>
              <div className="calendar-grid">
                {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
                  <div className="weekday" key={i}>
                    {d}
                  </div>
                ))}
                {(() => {
                  const year = Number(calendarMonth.slice(0, 4)),
                    month = Number(calendarMonth.slice(5)) - 1,
                    offset = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7,
                    days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
                  return [...Array(offset)]
                    .map((_, i) => <div key={'e' + i} />)
                    .concat(
                      [...Array(days)].map((_, i) => {
                        const iso = dayString(new Date(Date.UTC(year, month, i + 1))),
                          entry = calendarSeries.find((d) => d.day === iso),
                          hot = !!entry?.occupied_cells
                        return (
                          <button
                            key={iso}
                            className={
                              (iso === selectedDay ? 'selected ' : '') + (hot ? 'has-fire' : '')
                            }
                            disabled={iso > today() || calendarLoading}
                            onClick={() => {
                              if (!calendarSeries.some((d) => d.day === iso)) void loadCalendarMonth(iso.slice(0, 7), iso)
                              else {
                                setSelectedFire(null)
                                setSelectedDay(iso)
                              }
                            }}
                          >
                            {i + 1}
                          </button>
                        )
                      }),
                    )
                })()}
              </div>
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
                {calendarSeries.filter((d) => d.day.startsWith(`${calendarMonth}-`) && d.occupied_cells > 0).length} days with detections this month <ArrowRight size={15} />
              </div>
              <p className="calendar-explainer">An active day has at least one occupied grid cell in {region}. Each day is counted once (UTC), regardless of the number of detections.</p>
              <div className="coverage-note">
                <strong>Dual-sensor coverage</strong>
                <span>{coverageStart && coverageEnd ? `${coverageStart} to ${coverageEnd}` : 'No complete MODIS + VIIRS days loaded for this month'}</span>
                <small>NASA FIRMS observations for this region; dates may have gaps.</small>
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
                  <button className="export-button" onClick={downloadCsv} title="Download observation data as CSV"><Download size={13} /> CSV</button>
                  <button className="export-button" onClick={downloadChart} title="Download chart as SVG"><Download size={13} /> Chart</button>
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
                  {metric === 'frp' ? 'Harmonized FRP proxy' : 'Occupied cells'}
                </span>
              </div>
              <p className="chart-note">
                {metric === 'count'
                  ? 'MODIS and VIIRS lines count FIRMS detections; the harmonized line counts occupied 0.5° grid cells.'
                  : 'The harmonized FRP line sums the larger sensor FRP value in each occupied cell; it is an exploratory proxy.'}
              </p>
              <div className="trend-insight" aria-live="polite">
                <strong>What this period shows</strong>
                {peakDay && observedTrend.length >= 3 ? (
                  <span>
                    {peakDay.occupied_cells > 0 ? <>Peak observed activity was {new Date(`${peakDay.day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}: {nf.format(peakDay.occupied_cells)} occupied cells
                    {peakAboveTypical !== null ? ` (${peakAboveTypical}% above the median of ${nf.format(typicalCells)} cells)` : `; the median was ${nf.format(typicalCells)} cells`} across {observedTrend.length} dual-sensor days in the displayed 30-day window.
                    </> : `No occupied grid cells were recorded across ${observedTrend.length} days with both sensors reporting in the displayed 30-day window.`}
                  </span>
                ) : (
                  <span>Load at least three days with both MODIS and VIIRS coverage to compare the observed peak with the period median.</span>
                )}
              </div>
            </section>
            <section className="panel method-panel" id="method">
              <div className="panel-kicker">THE METHOD</div>
              <h2>One grid. Two sensors.</h2>
              <p>
                Each FIRMS detection is assigned to a 0.5° latitude/longitude cell using its coordinates and acquisition date in UTC. For each cell-day, EarthFire keeps MODIS and VIIRS counts separately, then counts the cell once in the harmonized activity total. This puts different sensor resolutions on a shared comparison grid; it does not claim detections are the same fire.
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
                <CircleHelp size={16} /> An occupied cell means one or more detections occurred in that grid cell on that UTC day. It is an activity indicator, not a fire count, fire perimeter, or fire probability.
              </div>
              <div className="source-coverage">
                <strong>Data &amp; coverage</strong>
                <span>NASA FIRMS active-fire detections · MODIS (Terra/Aqua) and VIIRS (Suomi-NPP, NOAA-20, NOAA-21)</span>
                <span>{coverageStart && coverageEnd ? `${coverageStart} — ${coverageEnd} · ${calendarCoverage.length} days with both sensor families available` : 'Coverage dates appear after the selected period loads'}</span>
                <a href="https://firms.modaps.eosdis.nasa.gov/" target="_blank" rel="noreferrer">NASA FIRMS data source</a>
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

