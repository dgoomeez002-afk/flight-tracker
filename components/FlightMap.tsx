'use client';

import { useEffect, useRef, useState } from 'react';
import type { FlightData } from '@/lib/scrapers';

interface FlightMapProps {
  flight: FlightData & { cached?: boolean };
}

interface LivePos {
  lat: number;
  lon: number;
  altitude: string;
  speed: string;
  heading: string;
  source: string;
}

// Airport coordinates lookup
const AIRPORT_COORDS: Record<string, [number, number]> = {
  // España
  'MAD': [40.4719, -3.5626], 'BCN': [41.2971, 2.0785], 'PMI': [39.5517, 2.7388],
  'AGP': [36.6749, -4.4991], 'ALC': [38.2822, -0.5582], 'VLC': [39.4893, -0.4816],
  'BIO': [43.3011, -2.9106], 'SVQ': [37.4180, -5.8931], 'TFS': [28.0445, -16.5725],
  'LPA': [27.9319, -15.3866], 'ACE': [28.9455, -13.6052], 'FUE': [28.4527, -13.8638],
  'SDR': [43.4271, -3.8200], 'OVD': [43.5636, -6.0346], 'VGO': [42.2318, -8.6277],
  'SCQ': [42.8963, -8.4151], 'GRX': [37.1887, -3.7774], 'MXP': [45.6306, 8.7281],
  'IBZ': [38.8729, 1.3731], 'MAH': [39.8626, 4.2186], 'ZAZ': [41.6663, -1.0415],
  'XRY': [36.7446, -6.0601], 'GRO': [41.9010, 2.7605],
  // Europa
  'LHR': [51.4775, -0.4614], 'CDG': [49.0097, 2.5479], 'AMS': [52.3105, 4.7683],
  'FRA': [50.0379, 8.5622], 'FCO': [41.8003, 12.2389], 'MUC': [48.3537, 11.7750],
  'ZRH': [47.4647, 8.5492], 'VIE': [48.1103, 16.5697], 'BRU': [50.9014, 4.4844],
  'LIS': [38.7813, -9.1359], 'ATH': [37.9364, 23.9445], 'CPH': [55.6180, 12.6560],
  'ARN': [59.6519, 17.9196], 'OSL': [60.1939, 11.1004], 'HEL': [60.3172, 24.9633],
  'DUB': [53.4213, -6.2701], 'MAN': [53.3537, -2.2750], 'IST': [41.2608, 28.7418],
  'ORY': [48.7233, 2.3794], 'NCE': [43.6584, 7.2158], 'BER': [52.3667, 13.5033],
  'HAM': [53.6304, 10.0063], 'DUS': [51.2895, 6.7668],
};

function getAirportCoords(iata: string): [number, number] | null {
  return AIRPORT_COORDS[iata] || null;
}

// Generate callsign variants to try (IB2454 → also try ANE2454, IBE2454, etc.)
function getCallsignVariants(flightNumber: string): string[] {
  const base = flightNumber.replace(/\s/g, '').toUpperCase();
  const variants = [base];
  // Iberia operated by Air Nostrum: IB↔ANE
  if (base.startsWith('IB')) variants.push('ANE' + base.slice(2));
  if (base.startsWith('ANE')) variants.push('IB' + base.slice(3));
  // Iberia Express: I2↔IBS
  if (base.startsWith('I2')) variants.push('IBS' + base.slice(2));
  if (base.startsWith('IBS')) variants.push('I2' + base.slice(3));
  // Vueling: VY↔VLG
  if (base.startsWith('VY')) variants.push('VLG' + base.slice(2));
  if (base.startsWith('VLG')) variants.push('VY' + base.slice(3));
  return variants;
}

// Fetch live GPS position directly from browser (bypasses Vercel server restrictions)
async function fetchLivePosition(flightNumber: string): Promise<LivePos | null> {
  const variants = getCallsignVariants(flightNumber);

  for (const callsign of variants) {
  // Try ADSB.lol first
  try {
    const res = await fetch(`https://api.adsb.lol/v2/callsign/${callsign}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ac && data.ac.length > 0) {
        const ac = data.ac[0];
        if (ac.lat && ac.lon) {
          const altFt = typeof ac.alt_baro === 'number' ? ac.alt_baro : (typeof ac.alt_geom === 'number' ? ac.alt_geom : null);
          return {
            lat: ac.lat,
            lon: ac.lon,
            altitude: altFt ? `${Math.round(altFt).toLocaleString()} ft` : '—',
            speed: ac.gs ? `${Math.round(ac.gs)} kn` : '—',
            heading: ac.track ? `${Math.round(ac.track)}°` : '0°',
            source: 'ADSB.lol',
          };
        }
      }
    }
  } catch { /* fallthrough */ }

  // Try airplanes.live
  try {
    const res = await fetch(`https://api.airplanes.live/v2/callsign/${callsign}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ac && data.ac.length > 0) {
        const ac = data.ac[0];
        if (ac.lat && ac.lon) {
          const altFt = typeof ac.alt_baro === 'number' ? ac.alt_baro : null;
          return {
            lat: ac.lat,
            lon: ac.lon,
            altitude: altFt ? `${Math.round(altFt).toLocaleString()} ft` : '—',
            speed: ac.gs ? `${Math.round(ac.gs)} kn` : '—',
            heading: ac.track ? `${Math.round(ac.track)}°` : '0°',
            source: 'airplanes.live',
          };
        }
      }
    }
  } catch { /* fallthrough */ }
  } // end for variants

  return null;
}

export default function FlightMap({ flight }: FlightMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapInstanceRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const planeMarkerRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const routeLineRef = useRef<any>(null);

  // Live position fetched client-side (bypasses Vercel server blocks)
  const [livePos, setLivePos] = useState<LivePos | null>(null);
  const [fetchStatus, setFetchStatus] = useState<'loading' | 'ok' | 'error'>('loading');

  const depCoords = getAirportCoords(flight.departure.iata);
  const arrCoords = getAirportCoords(flight.arrival.iata);

  // Use server position as fallback if live fetch hasn't resolved yet
  const pos: LivePos | null = livePos ?? (
    flight.lat != null && flight.lon != null
      ? {
          lat: flight.lat,
          lon: flight.lon,
          altitude: flight.altitude,
          speed: flight.speed,
          heading: flight.heading,
          source: flight.source,
        }
      : null
  );

  // Fetch live position from browser on mount and every 30s
  useEffect(() => {
    let cancelled = false;

    const doFetch = async () => {
      setFetchStatus('loading');
      const result = await fetchLivePosition(flight.flightNumber);
      if (!cancelled) {
        if (result) {
          setLivePos(result);
          setFetchStatus('ok');
        } else {
          setFetchStatus('error');
        }
      }
    };

    doFetch();
    const interval = setInterval(doFetch, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [flight.flightNumber]);

  // Map initialization
  useEffect(() => {
    if (!mapRef.current) return;
    if (typeof window === 'undefined') return;

    import('leaflet').then((L) => {
      // Fix default icon issue with webpack
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (L.Icon.Default.prototype as any)._getIconUrl;
      L.Icon.Default.mergeOptions({
        iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
        iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
        shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
      });

      // Initialize map only once
      if (!mapInstanceRef.current) {
        let center: [number, number] = [40.0, -3.5];
        let zoom = 6;

        if (pos) {
          center = [pos.lat, pos.lon];
          zoom = 7;
        } else if (depCoords && arrCoords) {
          center = [(depCoords[0] + arrCoords[0]) / 2, (depCoords[1] + arrCoords[1]) / 2];
        } else if (depCoords) {
          center = depCoords;
        }

        const map = L.map(mapRef.current!, {
          center,
          zoom,
          zoomControl: true,
          attributionControl: true,
        });

        // OpenStreetMap tiles — sin API key, sin restricciones
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          maxZoom: 19,
        }).addTo(map);

        mapInstanceRef.current = map;
      }
    });

    return () => { /* keep map alive */ };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update markers when position changes
  useEffect(() => {
    if (!mapInstanceRef.current) return;

    import('leaflet').then((L) => {
      const map = mapInstanceRef.current;

      // Clear previous markers/lines
      if (routeLineRef.current) { map.removeLayer(routeLineRef.current); routeLineRef.current = null; }
      if (planeMarkerRef.current) { map.removeLayer(planeMarkerRef.current); planeMarkerRef.current = null; }

      // Route line
      if (depCoords && arrCoords) {
        const routeLine = L.polyline([depCoords, arrCoords], {
          color: '#ffc107',
          weight: 2,
          opacity: 0.5,
          dashArray: '8, 6',
        }).addTo(map);
        routeLineRef.current = routeLine;

        const airportIcon = L.divIcon({
          html: `<div style="width:10px;height:10px;background:#ffc107;border-radius:50%;border:2px solid #fff;"></div>`,
          className: '',
          iconSize: [10, 10],
          iconAnchor: [5, 5],
        });

        L.marker(depCoords, { icon: airportIcon })
          .addTo(map)
          .bindPopup(`<b>${flight.departure.iata}</b><br>${flight.departure.name || ''}`, { className: 'dark-popup' });

        L.marker(arrCoords, { icon: airportIcon })
          .addTo(map)
          .bindPopup(`<b>${flight.arrival.iata}</b><br>${flight.arrival.name || ''}`, { className: 'dark-popup' });
      }

      // Plane marker
      if (pos) {
        const headingDeg = parseInt(pos.heading?.replace('°', '') || '0') || 0;

        const planeIcon = L.divIcon({
          html: `
            <div style="transform: rotate(${headingDeg}deg); width:32px; height:32px; display:flex; align-items:center; justify-content:center; filter: drop-shadow(0 0 4px #ffc107);">
              <svg viewBox="0 0 24 24" width="28" height="28" fill="#ffc107" xmlns="http://www.w3.org/2000/svg">
                <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>
              </svg>
            </div>
          `,
          className: '',
          iconSize: [32, 32],
          iconAnchor: [16, 16],
        });

        const planeMarker = L.marker([pos.lat, pos.lon], { icon: planeIcon })
          .addTo(map)
          .bindPopup(`
            <div style="font-family:monospace; min-width:160px;">
              <b style="color:#ffc107; font-size:14px;">${flight.flightNumber}</b><br>
              <span style="color:#aaa;">✈ ${flight.aircraft !== '—' ? flight.aircraft : ''}</span><br>
              <hr style="border-color:#333; margin:4px 0;">
              📍 ${pos.lat.toFixed(4)}°N, ${pos.lon.toFixed(4)}°E<br>
              🏔 ${pos.altitude}<br>
              💨 ${pos.speed}<br>
              🧭 ${pos.heading}<br>
              <hr style="border-color:#333; margin:4px 0;">
              <small style="color:#888;">Fuente: ${pos.source}</small>
            </div>
          `, { className: 'dark-popup' })
          .openPopup();

        planeMarkerRef.current = planeMarker;
        map.setView([pos.lat, pos.lon], Math.max(map.getZoom(), 7));
      }
    });
  }, [pos, depCoords, arrCoords, flight]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, []);

  return (
    <div style={{ position: 'relative' }}>
      <style>{`
        .leaflet-container {
          background: #1a1c23 !important;
          font-family: inherit;
        }
        .leaflet-popup-content-wrapper {
          background: #252830 !important;
          color: #e0e0e0 !important;
          border: 1px solid #3a3d4a !important;
          border-radius: 8px !important;
          box-shadow: 0 4px 20px rgba(0,0,0,0.5) !important;
        }
        .leaflet-popup-tip {
          background: #252830 !important;
        }
        .leaflet-popup-close-button {
          color: #888 !important;
        }
        .leaflet-control-zoom a {
          background: #252830 !important;
          color: #ffc107 !important;
          border-color: #3a3d4a !important;
        }
        .leaflet-control-zoom a:hover {
          background: #1a1c23 !important;
        }
        .leaflet-control-attribution {
          background: rgba(26,28,35,0.8) !important;
          color: #666 !important;
          font-size: 10px !important;
        }
        .leaflet-control-attribution a {
          color: #888 !important;
        }
      `}</style>
      <div
        ref={mapRef}
        style={{
          width: '100%',
          height: '400px',
          borderRadius: '12px',
          border: '1px solid #3a3d4a',
          overflow: 'hidden',
        }}
      />
      {/* Status badge */}
      <div style={{
        position: 'absolute',
        top: '8px',
        right: '8px',
        background: 'rgba(26,28,35,0.9)',
        border: `1px solid ${fetchStatus === 'ok' ? '#22c55e' : fetchStatus === 'error' ? '#ef4444' : '#3a3d4a'}`,
        borderRadius: '6px',
        padding: '4px 8px',
        color: fetchStatus === 'ok' ? '#22c55e' : fetchStatus === 'error' ? '#ef4444' : '#888',
        fontSize: '11px',
        zIndex: 1000,
      }}>
        {fetchStatus === 'loading' && '⏳ Buscando posición...'}
        {fetchStatus === 'ok' && pos && `✅ GPS: ${pos.lat.toFixed(3)}°N ${pos.lon.toFixed(3)}°E`}
        {fetchStatus === 'error' && '❌ GPS no disponible'}
      </div>
      {/* No position overlay */}
      {!pos && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          background: 'rgba(26,28,35,0.9)',
          border: '1px solid #3a3d4a',
          borderRadius: '8px',
          padding: '12px 20px',
          color: '#888',
          fontSize: '13px',
          textAlign: 'center',
          pointerEvents: 'none',
          zIndex: 999,
        }}>
          📡 Posición GPS no disponible<br />
          <span style={{ fontSize: '11px' }}>Se muestra la ruta {flight.departure.iata} → {flight.arrival.iata}</span>
        </div>
      )}
    </div>
  );
}
