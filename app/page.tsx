'use client';
import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import type { FlightData } from '@/lib/scrapers';

// Leaflet mapa — carga dinámica para evitar SSR issues
const FlightMap = lazy(() => import('@/components/FlightMap'));

const REFRESH_INTERVAL = 30; // seconds

const AIRPORTS: Record<string, { name: string; city: string }> = {
  BIO: { name: 'Bilbao Airport', city: 'Bilbao' },
  PMI: { name: 'Palma de Mallorca', city: 'Palma' },
  MAD: { name: 'Adolfo Suárez', city: 'Madrid' },
  BCN: { name: 'El Prat', city: 'Barcelona' },
  AMS: { name: 'Schiphol', city: 'Ámsterdam' },
  MUC: { name: 'Franz Josef Strauss', city: 'Múnich' },
  LHR: { name: 'Heathrow', city: 'Londres' },
  CDG: { name: 'Charles de Gaulle', city: 'París' },
  VLC: { name: 'Manises', city: 'Valencia' },
  SVQ: { name: 'San Pablo', city: 'Sevilla' },
};

const STATUS_MAP = {
  scheduled: { cls: 's-scheduled', label: 'Programado' },
  active: { cls: 's-active', label: 'En vuelo' },
  delayed: { cls: 's-delayed', label: 'Retrasado' },
  landed: { cls: 's-landed', label: 'Aterrizado' },
  cancelled: { cls: 's-cancelled', label: 'Cancelado' },
  unknown: { cls: 's-unknown', label: 'Sin datos' },
};

// Genera variantes de indicativo: IB2454 → [IB2454, ANE2454], etc.
function getCallsignVariants(flightNumber: string): string[] {
  const base = flightNumber.replace(/\s/g, '').toUpperCase();
  const variants: string[] = [];
  if (base.startsWith('IB')) variants.push('ANE' + base.slice(2));
  else if (base.startsWith('ANE')) variants.push('IB' + base.slice(3));
  if (base.startsWith('I2')) variants.push('IBS' + base.slice(2));
  else if (base.startsWith('IBS')) variants.push('I2' + base.slice(3));
  if (base.startsWith('VY')) variants.push('VLG' + base.slice(2));
  else if (base.startsWith('VLG')) variants.push('VY' + base.slice(3));
  return variants;
}

function getRouteCoords(from: string, to: string) {
  const coords: Record<string, [number, number]> = {
    BIO: [2.9, 43.3], PMI: [2.7, 39.6], MAD: [-3.6, 40.4],
    BCN: [2.1, 41.3], AMS: [4.9, 52.3], MUC: [11.8, 48.4],
    LHR: [-0.5, 51.5], CDG: [2.5, 49.0], VLC: [-0.5, 39.5],
    SVQ: [-5.9, 37.4],
  };
  return { origin: coords[from] || [-3.6, 40.4], dest: coords[to] || [2.7, 39.6] };
}

function routeToSVG(ox: number, oy: number, dx: number, dy: number, progress: number, status: string) {
  // Normalize lon/lat to SVG 0-100
  const allX = [ox, dx], allY = [oy, dy];
  const minX = Math.min(...allX) - 2, maxX = Math.max(...allX) + 2;
  const minY = Math.min(...allY) - 2, maxY = Math.max(...allY) + 2;
  const toSVG = (lon: number, lat: number) => ({
    x: ((lon - minX) / (maxX - minX)) * 90 + 5,
    y: 95 - ((lat - minY) / (maxY - minY)) * 90,
  });
  const O = toSVG(ox, oy);
  const D = toSVG(dx, dy);
  const C = { x: (O.x + D.x) / 2, y: Math.min(O.y, D.y) - 15 };
  const p = progress / 100;
  const px = (1 - p) * (1 - p) * O.x + 2 * (1 - p) * p * C.x + p * p * D.x;
  const py = (1 - p) * (1 - p) * O.y + 2 * (1 - p) * p * C.y + p * p * D.y;
  const dpx = 2 * (1 - p) * (C.x - O.x) + 2 * p * (D.x - C.x);
  const dpy = 2 * (1 - p) * (C.y - O.y) + 2 * p * (D.y - C.y);
  const angle = Math.atan2(dpy, dpx) * 180 / Math.PI;
  const isFlying = status === 'active';
  const planeColor = isFlying ? '#ffc107' : status === 'landed' ? '#4caf50' : '#6b7a99';
  return { O, D, C, px, py, angle, planeColor, isFlying };
}

export default function Home() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<(FlightData & { cached?: boolean }) | null>(null);
  const [error, setError] = useState('');
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL);
  const [lastUpdated, setLastUpdated] = useState('');
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const countRef = useRef<NodeJS.Timeout | null>(null);
  const currentFlight = useRef('');

  const fetchFlight = useCallback(async (flightNum: string, silent = false) => {
    if (!flightNum) return;
    if (!silent) setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/flight?flight=${encodeURIComponent(flightNum)}`);
      const json = await res.json();
      if (!res.ok) { setError(json.error || 'Error desconocido'); setData(null); }
      else { setData(json); setLastUpdated(new Date().toLocaleTimeString('es-ES')); }
    } catch {
      setError('Error de conexión');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const startAutoRefresh = useCallback((flightNum: string) => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (countRef.current) clearInterval(countRef.current);
    setCountdown(REFRESH_INTERVAL);
    countRef.current = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { fetchFlight(flightNum, true); return REFRESH_INTERVAL; }
        return c - 1;
      });
    }, 1000);
  }, [fetchFlight]);

  const search = (flight?: string) => {
    const f = (flight || query).toUpperCase().trim();
    if (!f) return;
    currentFlight.current = f;
    setQuery(f);
    fetchFlight(f).then(() => startAutoRefresh(f));
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (countRef.current) clearInterval(countRef.current);
    };
  }, []);

  const ap = (iata: string) => AIRPORTS[iata] || { name: iata, city: '' };
  const st = data ? (STATUS_MAP[data.status] || STATUS_MAP.unknown) : null;

  return (
    <>
      <style>{`
        .topbar { background:#13141a; border-bottom:1px solid var(--border); padding:0 16px; height:48px; display:flex; align-items:center; gap:12px; position:sticky; top:0; z-index:100; }
        .logo { display:flex; align-items:center; gap:8px; font-size:15px; font-weight:800; color:var(--text); }
        .logo-img { width:28px; height:28px; }
        .logo span { color:var(--yellow); }
        .topbar-sep { width:1px; height:20px; background:var(--border); }
        .topbar-label { font-size:11px; color:var(--muted); }
        .refresh-pill { margin-left:auto; display:flex; align-items:center; gap:5px; background:var(--bg3); border:1px solid var(--border2); border-radius:20px; padding:3px 10px; font-size:11px; color:var(--muted); }
        .refresh-dot { width:6px; height:6px; border-radius:50%; background:var(--yellow); animation: blink 1s infinite; }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.2} }
        .search-wrap { padding:12px 16px 10px; background:var(--bg); border-bottom:1px solid var(--border); }
        .search-row { display:flex; gap:8px; max-width:600px; }
        .search-input { flex:1; background:var(--bg3); border:1.5px solid var(--border2); border-radius:7px; padding:9px 14px; color:var(--text); font-size:14px; font-weight:600; letter-spacing:1.5px; text-transform:uppercase; outline:none; transition:border-color .15s; }
        .search-input::placeholder { color:var(--muted2); font-weight:400; letter-spacing:0; text-transform:none; }
        .search-input:focus { border-color:var(--yellow); }
        .search-btn { background:var(--yellow); color:#111; border:none; border-radius:7px; padding:9px 18px; font-weight:700; font-size:13px; transition:opacity .15s; }
        .search-btn:hover { opacity:.85; }
        .chips { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
        .chip { background:var(--bg3); border:1px solid var(--border); border-radius:5px; padding:3px 10px; font-size:11px; font-family:monospace; color:var(--muted); cursor:pointer; transition:all .12s; }
        .chip:hover { border-color:var(--yellow); color:var(--yellow); }
        .main { max-width:860px; margin:0 auto; padding:14px 12px 60px; }
        .loading { text-align:center; padding:60px 20px; color:var(--muted); }
        .spinner { width:32px; height:32px; border:2.5px solid var(--border2); border-top-color:var(--yellow); border-radius:50%; animation:spin .7s linear infinite; margin:0 auto 14px; }
        @keyframes spin { to { transform:rotate(360deg); } }
        .error-box { background:#2a1414; border:1px solid #5a2020; border-radius:10px; padding:24px; text-align:center; color:#ff8a80; }
        .fr-panel { background:var(--panel); border:1px solid var(--border); border-radius:10px; overflow:hidden; margin-bottom:12px; }
        .fr-header { background:#13141a; border-bottom:1px solid var(--border); padding:12px 16px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; }
        .fr-flight-id { font-family:monospace; font-size:22px; font-weight:700; color:var(--yellow); letter-spacing:1px; }
        .fr-airline { font-size:12px; color:var(--muted); margin-top:2px; }
        .fr-status { display:inline-flex; align-items:center; gap:5px; padding:4px 11px; border-radius:20px; font-size:12px; font-weight:600; }
        .fr-status .dot { width:6px; height:6px; border-radius:50%; }
        .s-scheduled { background:#0d2b0d; color:#66bb6a; } .s-scheduled .dot { background:#66bb6a; }
        .s-active { background:#0a1f35; color:var(--blue); } .s-active .dot { background:var(--blue); animation:blink 1s infinite; }
        .s-delayed { background:#2a1e00; color:var(--yellow); } .s-delayed .dot { background:var(--yellow); animation:blink 1.5s infinite; }
        .s-landed { background:#0d2a1a; color:#26a869; } .s-landed .dot { background:#26a869; }
        .s-cancelled { background:#2a0a0a; color:var(--red); } .s-cancelled .dot { background:var(--red); }
        .s-unknown { background:#1a1c23; color:var(--muted); } .s-unknown .dot { background:var(--muted); }
        .map-wrap { position:relative; background:#1b2535; height:220px; overflow:hidden; }
        .map-svg { width:100%; height:100%; display:block; }
        .map-badge { position:absolute; top:10px; left:10px; background:rgba(13,15,20,.8); border:1px solid var(--border2); border-radius:6px; padding:5px 10px; font-size:11px; color:var(--muted); font-family:monospace; backdrop-filter:blur(4px); }
        .map-badge span { color:var(--yellow); font-weight:700; }
        .map-link { position:absolute; bottom:10px; right:10px; background:rgba(0,0,0,.6); border:1px solid var(--border2); border-radius:6px; padding:6px 12px; color:var(--yellow); font-size:12px; font-weight:600; display:flex; align-items:center; gap:5px; backdrop-filter:blur(4px); }
        .fr-route { display:flex; align-items:stretch; border-bottom:1px solid var(--border); }
        .fr-airport { flex:1; padding:16px; text-align:center; }
        .fr-iata { font-family:monospace; font-size:28px; font-weight:700; }
        .fr-city { font-size:11px; color:var(--muted); margin-top:2px; }
        .fr-time-row { margin-top:8px; }
        .fr-label { font-size:10px; color:var(--muted2); text-transform:uppercase; letter-spacing:.4px; }
        .fr-time { font-family:monospace; font-size:17px; font-weight:700; }
        .fr-time.actual { color:var(--yellow); }
        .fr-time.delayed { color:var(--orange); }
        .fr-divider { display:flex; flex-direction:column; align-items:center; justify-content:center; padding:0 6px; min-width:80px; gap:4px; }
        .fr-arrow { display:flex; align-items:center; width:100%; gap:4px; }
        .fr-line { flex:1; height:1px; background:var(--border2); }
        .fr-plane { font-size:18px; color:var(--yellow); transform:rotate(45deg); display:inline-block; }
        .fr-dur { font-size:11px; color:var(--muted); font-family:monospace; }
        .fr-details { display:grid; grid-template-columns:repeat(auto-fit,minmax(100px,1fr)); gap:1px; background:var(--border); border-top:1px solid var(--border); }
        .fr-detail { background:var(--panel); padding:11px 14px; }
        .fr-detail-label { font-size:10px; color:var(--muted2); text-transform:uppercase; letter-spacing:.4px; margin-bottom:3px; }
        .fr-detail-val { font-family:monospace; font-size:13px; font-weight:600; }
        .ok { color:var(--green); } .warn { color:var(--yellow); } .bad { color:var(--red); }
        .track-btns { display:flex; gap:8px; padding:12px 14px; border-top:1px solid var(--border); flex-wrap:wrap; }
        .track-btn { flex:1; min-width:150px; display:flex; align-items:center; gap:10px; padding:10px 14px; border-radius:8px; text-decoration:none; border:1px solid; transition:opacity .15s; }
        .track-btn:hover { opacity:.8; }
        .tb-icon { width:30px; height:30px; border-radius:7px; display:flex; align-items:center; justify-content:center; font-size:15px; flex-shrink:0; }
        .tb-name { font-size:13px; font-weight:700; }
        .tb-sub { font-size:11px; opacity:.7; margin-top:1px; }
        .tb-fr { background:#1a1600; border-color:#4a3800; color:var(--yellow-soft); }
        .tb-fr .tb-icon { background:#ff6d00; color:#fff; }
        .tb-fa { background:#0f1e10; border-color:#1e4020; color:#81c784; }
        .tb-fa .tb-icon { background:#2e7d32; color:#fff; }
        .section-card { background:var(--panel); border:1px solid var(--border); border-radius:10px; overflow:hidden; margin-bottom:12px; }
        .section-head { background:#13141a; border-bottom:1px solid var(--border); padding:9px 16px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.5px; color:var(--muted); display:flex; align-items:center; gap:7px; justify-content:space-between; }
        .section-body { padding:14px 16px; }
        .sources-badge { font-size:10px; color:var(--muted2); font-family:monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:200px; }
        .updated { text-align:right; font-size:10px; color:var(--muted2); font-family:monospace; margin-bottom:8px; }
        @media (max-width:500px) {
          .fr-iata { font-size:22px; } .fr-time { font-size:14px; } .fr-divider { min-width:50px; }
          .fr-details { grid-template-columns:1fr 1fr; }
          .topbar-label { display:none; }
        }
      `}</style>

      {/* NAVBAR */}
      <div className="topbar">
        <div className="logo">
          <img src="/logo.svg" alt="Logo" className="logo-img" />
          flight<span>tracker</span>
        </div>
        <div className="topbar-sep" />
        <div className="topbar-label">Rastreo en tiempo real</div>
        {data && (
          <div className="refresh-pill">
            <span className="refresh-dot" />
            Actualiza en {countdown}s
          </div>
        )}
      </div>

      {/* SEARCH */}
      <div className="search-wrap">
        <div className="search-row">
          <input
            className="search-input"
            value={query}
            onChange={e => setQuery(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && search()}
            placeholder="Número de vuelo  ej. IB2454"
            maxLength={8}
          />
          <button className="search-btn" onClick={() => search()} disabled={loading}>
            {loading ? '…' : 'Buscar'}
          </button>
        </div>
        <div className="chips">
          {['IB2454', 'VY1465', 'LH1825', 'KL1524', 'IB436'].map(f => (
            <span key={f} className="chip" onClick={() => search(f)}>{f}</span>
          ))}
        </div>
      </div>

      <div className="main">
        {loading && (
          <div className="loading">
            <div className="spinner" />
            <p>Buscando {query}…</p>
            <p style={{ fontSize: 11, marginTop: 6, color: 'var(--muted2)' }}>Consultando FR24, FlightAware, OpenSky…</p>
          </div>
        )}

        {error && !loading && (
          <div className="error-box">
            <div style={{ fontSize: 28, marginBottom: 10 }}>🔍</div>
            <strong>{error}</strong>
            <p style={{ marginTop: 6, fontSize: 12, opacity: .7 }}>Prueba IB2454, VY1465, LH1825…</p>
          </div>
        )}

        {data && !loading && (() => {
          const o = ap(data.departure.iata);
          const d = ap(data.arrival.iata);
          const { O, D, C, px, py, angle, planeColor, isFlying } = (() => {
            const r = getRouteCoords(data.departure.iata, data.arrival.iata);
            return routeToSVG(r.origin[0], r.origin[1], r.dest[0], r.dest[1], data.progress, data.status);
          })();
          const st2 = STATUS_MAP[data.status] || STATUS_MAP.unknown;
          return (
            <>
              <div className="updated">Actualizado: {lastUpdated} · {data.cached ? 'Caché' : 'En vivo'}</div>

              <div className="fr-panel">
                <div className="fr-header">
                  <div>
                    <div className="fr-flight-id">{data.flightNumber}</div>
                    <div className="fr-airline">{data.airline} · {data.aircraft} · {data.registration}</div>
                    {/* Identificadores alternativos */}
                    {getCallsignVariants(data.flightNumber).length > 0 && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 11, color: 'var(--muted2)', whiteSpace: 'nowrap' }}>También conocido como:</span>
                        {getCallsignVariants(data.flightNumber).map(alt => (
                          <button
                            key={alt}
                            onClick={() => search(alt)}
                            style={{
                              background: 'rgba(255,193,7,0.12)',
                              border: '1px solid rgba(255,193,7,0.4)',
                              borderRadius: 6,
                              color: '#ffc107',
                              fontSize: 12,
                              fontWeight: 700,
                              fontFamily: 'monospace',
                              padding: '2px 8px',
                              cursor: 'pointer',
                              transition: 'background 0.15s',
                            }}
                            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,193,7,0.22)')}
                            onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,193,7,0.12)')}
                            title={`Buscar con indicativo ${alt}`}
                          >
                            {alt}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className={`fr-status ${st2.cls}`}>
                    <span className="dot" />
                    {st2.label}{data.delay > 0 ? ` · +${data.delay} min` : ''}
                  </div>
                </div>

                {/* SVG MAP */}
                <div className="map-wrap">
                  <svg className="map-svg" viewBox="0 0 100 70" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">
                    <defs>
                      <radialGradient id="mg" cx="50%" cy="50%" r="60%">
                        <stop offset="0%" stopColor="#1e3050" />
                        <stop offset="100%" stopColor="#0d1520" />
                      </radialGradient>
                    </defs>
                    <rect width="100" height="70" fill="url(#mg)" />
                    <g stroke="#ffffff07" strokeWidth="0.3">
                      <line x1="0" y1="17.5" x2="100" y2="17.5" /><line x1="0" y1="35" x2="100" y2="35" />
                      <line x1="0" y1="52.5" x2="100" y2="52.5" /><line x1="25" y1="0" x2="25" y2="70" />
                      <line x1="50" y1="0" x2="50" y2="70" /><line x1="75" y1="0" x2="75" y2="70" />
                    </g>
                    {/* Route ghost */}
                    <path d={`M${O.x},${O.y} Q${C.x},${C.y} ${D.x},${D.y}`} stroke="#ffc10730" strokeWidth="0.6" fill="none" strokeDasharray="1.5,1.5" />
                    {/* Route flown */}
                    {(isFlying || data.status === 'landed') && (
                      <path d={`M${O.x},${O.y} Q${C.x},${C.y} ${px},${py}`} stroke="#4caf50" strokeWidth="0.9" fill="none" opacity="0.9" />
                    )}
                    {/* Origin */}
                    <circle cx={O.x} cy={O.y} r="1.5" fill="#ffc107" opacity="0.9" />
                    <text x={O.x} y={O.y - 2.5} textAnchor="middle" fontSize="2.8" fill="#ffc107" fontWeight="bold" fontFamily="monospace">{data.departure.iata}</text>
                    {/* Dest */}
                    <circle cx={D.x} cy={D.y} r="1.5" fill={data.status === 'landed' ? '#26a869' : '#8b8fa8'} opacity="0.9" />
                    <text x={D.x} y={D.y + 4.5} textAnchor="middle" fontSize="2.8" fill={data.status === 'landed' ? '#26a869' : '#8b8fa8'} fontWeight="bold" fontFamily="monospace">{data.arrival.iata}</text>
                    {/* Plane */}
                    <g transform={`translate(${px},${py}) rotate(${angle})`}>
                      <text x="0" y="0" textAnchor="middle" dominantBaseline="central" fontSize={isFlying ? '4.5' : '3.5'} fill={planeColor}>✈</text>
                    </g>
                    {isFlying && (
                      <circle cx={px} cy={py} r="2" fill="none" stroke={planeColor} strokeWidth="0.4" opacity="0.5">
                        <animate attributeName="r" values="2;5;2" dur="2s" repeatCount="indefinite" />
                        <animate attributeName="opacity" values="0.5;0;0.5" dur="2s" repeatCount="indefinite" />
                      </circle>
                    )}
                  </svg>
                  <div className="map-badge">
                    {isFlying ? (
                      <>Alt <span>{data.altitude}</span> · Vel <span>{data.speed}</span> · Hdg <span>{data.heading}</span></>
                    ) : (
                      <>{data.status === 'scheduled' ? 'En tierra · Programado' : data.status === 'landed' ? 'Vuelo aterrizado' : st2.label}</>
                    )}
                  </div>
                  <a className="map-link" href={`https://www.flightradar24.com/data/flights/${data.flightNumber.toLowerCase()}`} target="_blank" rel="noopener">
                    📡 Ver en FR24
                  </a>
                </div>

                {/* ROUTE */}
                <div className="fr-route">
                  <div className="fr-airport">
                    <div className="fr-iata">{data.departure.iata}</div>
                    <div className="fr-city">{data.departure.city || o.city}</div>
                    <div className="fr-time-row">
                      <div className="fr-label">Programado</div>
                      <div className="fr-time">{data.departure.scheduled || '—'}</div>
                    </div>
                    {data.departure.actual && (
                      <div className="fr-time-row">
                        <div className="fr-label">Real</div>
                        <div className="fr-time actual">{data.departure.actual}</div>
                      </div>
                    )}
                    {!data.departure.actual && data.departure.estimated && (
                      <div className="fr-time-row">
                        <div className="fr-label">Estimado</div>
                        <div className="fr-time delayed">{data.departure.estimated}</div>
                      </div>
                    )}
                  </div>
                  <div className="fr-divider">
                    <div className="fr-arrow"><div className="fr-line" /><div className="fr-plane">✈</div><div className="fr-line" /></div>
                    <div className="fr-dur" style={{ fontSize: 10, color: 'var(--muted)' }}>{data.departure.scheduled && data.arrival.scheduled ? '' : '—'}</div>
                  </div>
                  <div className="fr-airport">
                    <div className="fr-iata">{data.arrival.iata}</div>
                    <div className="fr-city">{data.arrival.city || d.city}</div>
                    <div className="fr-time-row">
                      <div className="fr-label">Programado</div>
                      <div className="fr-time">{data.arrival.scheduled || '—'}</div>
                    </div>
                    {data.arrival.actual && (
                      <div className="fr-time-row">
                        <div className="fr-label">Real</div>
                        <div className="fr-time actual">{data.arrival.actual}</div>
                      </div>
                    )}
                    {!data.arrival.actual && data.arrival.estimated && (
                      <div className="fr-time-row">
                        <div className="fr-label">Estimado</div>
                        <div className="fr-time delayed">{data.arrival.estimated}</div>
                      </div>
                    )}
                  </div>
                </div>

                {/* DETAILS */}
                <div className="fr-details">
                  <div className="fr-detail"><div className="fr-detail-label">Puerta</div><div className={`fr-detail-val ${data.departure.gate ? 'ok' : 'warn'}`}>{data.departure.gate || '—'}</div></div>
                  <div className="fr-detail"><div className="fr-detail-label">Terminal</div><div className={`fr-detail-val ${data.departure.terminal ? 'ok' : 'warn'}`}>{data.departure.terminal || '—'}</div></div>
                  <div className="fr-detail"><div className="fr-detail-label">Retraso</div><div className={`fr-detail-val ${data.delay > 0 ? 'warn' : 'ok'}`}>{data.delay > 0 ? `+${data.delay} min` : 'A tiempo'}</div></div>
                  <div className="fr-detail"><div className="fr-detail-label">Matrícula</div><div className="fr-detail-val">{data.registration}</div></div>
                  <div className="fr-detail"><div className="fr-detail-label">Altitud</div><div className="fr-detail-val">{data.altitude}</div></div>
                  <div className="fr-detail"><div className="fr-detail-label">Velocidad</div><div className="fr-detail-val">{data.speed}</div></div>
                </div>

                {/* TRACK BUTTONS */}
                <div className="track-btns">
                  <a className="track-btn tb-fr" href={`https://www.flightradar24.com/data/flights/${data.flightNumber.toLowerCase()}`} target="_blank" rel="noopener">
                    <div className="tb-icon">📡</div>
                    <div><div className="tb-name">Flightradar24</div><div className="tb-sub">Rastreo en vivo</div></div>
                    <div style={{ marginLeft: 'auto', opacity: .4 }}>›</div>
                  </a>
                  <a className="track-btn tb-fa" href={`https://www.flightaware.com/live/flight/${data.flightNumber}`} target="_blank" rel="noopener">
                    <div className="tb-icon">🛫</div>
                    <div><div className="tb-name">FlightAware</div><div className="tb-sub">Estado · Historial</div></div>
                    <div style={{ marginLeft: 'auto', opacity: .4 }}>›</div>
                  </a>
                </div>
              </div>

              {/* MAPA INTERACTIVO */}
              <div className="section-card">
                <div className="section-head">
                  <span>🗺 Mapa en tiempo real</span>
                  {data.lat != null ? (
                    <span style={{ fontSize: 10, color: 'var(--green)', fontFamily: 'monospace' }}>
                      📍 {data.lat.toFixed(4)}°N {data.lon?.toFixed(4)}°E
                    </span>
                  ) : (
                    <span style={{ fontSize: 10, color: 'var(--muted2)' }}>GPS no disponible</span>
                  )}
                </div>
                <div style={{ padding: '12px' }}>
                  <Suspense fallback={
                    <div style={{ height: 400, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#1a1c23', borderRadius: 12, color: 'var(--muted)' }}>
                      🗺 Cargando mapa…
                    </div>
                  }>
                    <FlightMap flight={data} />
                  </Suspense>
                </div>
              </div>

              {/* SOURCES */}
              <div className="section-card">
                <div className="section-head">
                  <span>📡 Fuentes de datos</span>
                  <span className="sources-badge">{data.source}</span>
                </div>
                <div className="section-body" style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  {[
                    { name: 'ADSB.lol', desc: 'Posición GPS ADS-B', free: true },
                    { name: 'airplanes.live', desc: 'GPS en vivo sin límites', free: true },
                    { name: 'OpenSky Network', desc: 'ADS-B + búsqueda área', free: true },
                    { name: 'ADSBDB', desc: 'Datos aeronave + ruta', free: true },
                    { name: 'FlightStats', desc: 'Horarios y estado', free: true },
                    { name: 'AviationStack', desc: 'Estado + horarios completos', free: 'API key' },
                    { name: 'FlightAware AeroAPI', desc: 'Datos completos', free: 'API key' },
                  ].map(s => (
                    <div key={s.name} style={{ flex: '1', minWidth: 140, background: 'var(--bg3)', borderRadius: 8, padding: '10px 12px' }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{s.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{s.desc}</div>
                      <div style={{ fontSize: 10, color: s.free === true ? 'var(--green)' : 'var(--yellow)', marginTop: 4 }}>
                        {s.free === true ? '✓ Gratis · Sin key' : `⚙ Requiere ${s.free}`}
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ padding: '0 16px 14px', fontSize: 11, color: 'var(--muted2)' }}>
                  Añade <code style={{ color: 'var(--yellow)', background: 'var(--bg3)', padding: '1px 5px', borderRadius: 4 }}>AVIATIONSTACK_KEY</code> y <code style={{ color: 'var(--yellow)', background: 'var(--bg3)', padding: '1px 5px', borderRadius: 4 }}>FLIGHTAWARE_KEY</code> en Vercel → Settings → Environment Variables para datos completos.
                </div>
              </div>
            </>
          );
        })()}
      </div>
    </>
  );
}
