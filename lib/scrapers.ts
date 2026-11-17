// Flight data scrapers - multiple sources with fallback
import * as cheerio from 'cheerio';

export interface FlightData {
  flightNumber: string;
  airline: string;
  aircraft: string;
  registration: string;
  status: 'scheduled' | 'active' | 'landed' | 'delayed' | 'cancelled' | 'unknown';
  departure: {
    iata: string;
    name: string;
    city: string;
    scheduled: string;
    actual: string | null;
    estimated: string | null;
    gate: string | null;
    terminal: string | null;
  };
  arrival: {
    iata: string;
    name: string;
    city: string;
    scheduled: string;
    actual: string | null;
    estimated: string | null;
    gate: string | null;
    terminal: string | null;
  };
  delay: number;
  progress: number;
  altitude: string;
  speed: string;
  heading: string;
  lat: number | null;
  lon: number | null;
  source: string;
  lastUpdated: string;
}

// --- OpenSky Network (free, no API key needed) ---
export async function scrapeOpenSky(flightNumber: string): Promise<Partial<FlightData> | null> {
  try {
    const callsign = flightNumber.replace(/\s/g, '').toUpperCase().padEnd(8);
    const url = `https://opensky-network.org/api/states/all?callsign=${callsign.trim()}`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'FlightTracker/1.0' },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return null;
    const data = await res.json();

    if (!data.states || data.states.length === 0) return null;

    const state = data.states[0];
    // OpenSky state vector: [icao24, callsign, origin_country, time_position, last_contact,
    //   longitude, latitude, baro_altitude, on_ground, velocity, true_track, vertical_rate,
    //   sensors, geo_altitude, squawk, spi, position_source]
    const lon = state[5];
    const lat = state[6];
    const alt = state[7]; // meters
    const speed = state[9]; // m/s
    const heading = state[10];
    const onGround = state[8];

    return {
      lat,
      lon,
      altitude: alt ? `${Math.round(alt * 3.28084)} ft` : '—',
      speed: speed ? `${Math.round(speed * 1.944)} kn` : '—',
      heading: heading ? `${Math.round(heading)}°` : '—',
      status: onGround ? 'active' : 'active',
      source: 'OpenSky Network',
    };
  } catch {
    return null;
  }
}

// --- AviationStack (free tier: 100 req/month) ---
export async function scrapeAviationStack(flightNumber: string): Promise<Partial<FlightData> | null> {
  const apiKey = process.env.AVIATIONSTACK_KEY;
  if (!apiKey) return null;

  try {
    const url = `http://api.aviationstack.com/v1/flights?access_key=${apiKey}&flight_iata=${flightNumber}&limit=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.data || data.data.length === 0) return null;

    const f = data.data[0];
    const statusMap: Record<string, FlightData['status']> = {
      'scheduled': 'scheduled',
      'active': 'active',
      'landed': 'landed',
      'cancelled': 'cancelled',
      'incident': 'cancelled',
      'diverted': 'active',
    };

    return {
      flightNumber: f.flight?.iata || flightNumber,
      airline: f.airline?.name || '',
      aircraft: f.aircraft?.iata || '',
      registration: f.aircraft?.registration || '',
      status: statusMap[f.flight_status] || 'unknown',
      departure: {
        iata: f.departure?.iata || '',
        name: f.departure?.airport || '',
        city: f.departure?.timezone?.split('/')[1]?.replace('_', ' ') || '',
        scheduled: formatTime(f.departure?.scheduled),
        actual: formatTime(f.departure?.actual),
        estimated: formatTime(f.departure?.estimated),
        gate: f.departure?.gate || null,
        terminal: f.departure?.terminal || null,
      },
      arrival: {
        iata: f.arrival?.iata || '',
        name: f.arrival?.airport || '',
        city: f.arrival?.timezone?.split('/')[1]?.replace('_', ' ') || '',
        scheduled: formatTime(f.arrival?.scheduled),
        actual: formatTime(f.arrival?.actual),
        estimated: formatTime(f.arrival?.estimated),
        gate: f.arrival?.gate || null,
        terminal: f.arrival?.terminal || null,
      },
      delay: f.departure?.delay || 0,
      source: 'AviationStack',
    };
  } catch {
    return null;
  }
}

// --- FlightAware AeroAPI (free: 10 req/min) ---
export async function scrapeFlightAware(flightNumber: string): Promise<Partial<FlightData> | null> {
  const apiKey = process.env.FLIGHTAWARE_KEY;
  if (!apiKey) return null;

  try {
    const url = `https://aeroapi.flightaware.com/aeroapi/flights/${flightNumber}`;
    const res = await fetch(url, {
      headers: { 'x-apikey': apiKey },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.flights || data.flights.length === 0) return null;

    const f = data.flights[0];
    return {
      flightNumber: f.ident,
      airline: f.operator || '',
      aircraft: f.aircraft_type || '',
      status: mapFlightAwareStatus(f.status),
      departure: {
        iata: f.origin?.code_iata || '',
        name: f.origin?.name || '',
        city: f.origin?.city || '',
        scheduled: formatTime(f.scheduled_out),
        actual: formatTime(f.actual_out),
        estimated: formatTime(f.estimated_out),
        gate: f.gate_origin || null,
        terminal: null,
      },
      arrival: {
        iata: f.destination?.code_iata || '',
        name: f.destination?.name || '',
        city: f.destination?.city || '',
        scheduled: formatTime(f.scheduled_in),
        actual: formatTime(f.actual_in),
        estimated: formatTime(f.estimated_in),
        gate: f.gate_destination || null,
        terminal: null,
      },
      delay: f.departure_delay || 0,
      progress: f.progress_percent || 0,
      lat: f.last_position?.latitude || null,
      lon: f.last_position?.longitude || null,
      altitude: f.last_position?.altitude ? `${f.last_position.altitude} ft` : '—',
      speed: f.last_position?.groundspeed ? `${f.last_position.groundspeed} kn` : '—',
      heading: f.last_position?.heading ? `${f.last_position.heading}°` : '—',
      source: 'FlightAware AeroAPI',
    };
  } catch {
    return null;
  }
}

// --- FR24 public HTML scraper (no API key, best-effort) ---
export async function scrapeFR24(flightNumber: string): Promise<Partial<FlightData> | null> {
  try {
    const url = `https://www.flightradar24.com/data/flights/${flightNumber.toLowerCase()}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'es-ES,es;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);

    // Extract JSON-LD if present
    const jsonLd = $('script[type="application/ld+json"]').first().text();
    if (jsonLd) {
      try {
        const ld = JSON.parse(jsonLd);
        if (ld.departureFlight || ld.name) {
          return { source: 'Flightradar24 (HTML)', flightNumber };
        }
      } catch { /* ignore */ }
    }

    return { source: 'Flightradar24 (HTML)', flightNumber };
  } catch {
    return null;
  }
}

// --- FlightStats scraper ---
export async function scrapeFlightStats(flightNumber: string): Promise<Partial<FlightData> | null> {
  try {
    const airline = flightNumber.match(/^[A-Z]+/)?.[0] || '';
    const number = flightNumber.match(/\d+/)?.[0] || '';
    const today = new Date();
    const url = `https://www.flightstats.com/v2/flight-tracker/${airline}/${number}`;

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);

    // Try to extract __NEXT_DATA__
    const nextData = $('#__NEXT_DATA__').text();
    if (nextData) {
      try {
        const nd = JSON.parse(nextData);
        const flight = nd?.props?.pageProps?.flightState?.flight;
        if (flight) {
          return {
            status: mapFlightstatsStatus(flight.status?.classification),
            departure: {
              iata: flight.departureAirport?.iata || '',
              name: flight.departureAirport?.name || '',
              city: flight.departureAirport?.city || '',
              scheduled: flight.departureDate?.scheduled?.time24 || '',
              actual: flight.departureDate?.actual?.time24 || null,
              estimated: flight.departureDate?.estimated?.time24 || null,
              gate: flight.departureGate || null,
              terminal: flight.departureTerminal || null,
            },
            arrival: {
              iata: flight.arrivalAirport?.iata || '',
              name: flight.arrivalAirport?.name || '',
              city: flight.arrivalAirport?.city || '',
              scheduled: flight.arrivalDate?.scheduled?.time24 || '',
              actual: flight.arrivalDate?.actual?.time24 || null,
              estimated: flight.arrivalDate?.estimated?.time24 || null,
              gate: flight.arrivalGate || null,
              terminal: flight.arrivalTerminal || null,
            },
            source: 'FlightStats',
          };
        }
      } catch { /* ignore */ }
    }

    return null;
  } catch {
    return null;
  }
}

// --- Merge results from multiple sources ---
export async function getFlightData(flightNumber: string): Promise<FlightData> {
  const code = flightNumber.toUpperCase().trim();

  // Run all scrapers in parallel
  const [opensky, aviationstack, flightaware, fr24, flightstats] = await Promise.allSettled([
    scrapeOpenSky(code),
    scrapeAviationStack(code),
    scrapeFlightAware(code),
    scrapeFR24(code),
    scrapeFlightStats(code),
  ]);

  const results = [opensky, aviationstack, flightaware, fr24, flightstats]
    .map(r => r.status === 'fulfilled' ? r.value : null)
    .filter(Boolean) as Partial<FlightData>[];

  // Merge: prefer FlightAware > AviationStack > FlightStats > FR24 > OpenSky
  const merged = results.reduce((acc, r) => ({ ...acc, ...r }), {} as Partial<FlightData>);

  // Priority override for live position: OpenSky has best real-time
  const os = opensky.status === 'fulfilled' ? opensky.value : null;
  if (os?.lat) {
    merged.lat = os.lat;
    merged.lon = os.lon;
    merged.altitude = os.altitude;
    merged.speed = os.speed;
    merged.heading = os.heading;
  }

  const sources = results.map(r => r?.source).filter(Boolean).join(' + ') || 'Sin datos';

  return {
    flightNumber: merged.flightNumber || code,
    airline: merged.airline || inferAirline(code),
    aircraft: merged.aircraft || '—',
    registration: merged.registration || '—',
    status: merged.status || 'unknown',
    departure: merged.departure || {
      iata: code.match(/^[A-Z]{2,3}/)?.[0] || '???',
      name: '—', city: '—',
      scheduled: '—', actual: null, estimated: null,
      gate: null, terminal: null,
    },
    arrival: merged.arrival || {
      iata: '???',
      name: '—', city: '—',
      scheduled: '—', actual: null, estimated: null,
      gate: null, terminal: null,
    },
    delay: merged.delay || 0,
    progress: merged.progress || 0,
    altitude: merged.altitude || '—',
    speed: merged.speed || '—',
    heading: merged.heading || '—',
    lat: merged.lat || null,
    lon: merged.lon || null,
    source: sources,
    lastUpdated: new Date().toISOString(),
  };
}

// --- Helpers ---
function formatTime(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('es-ES', {
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid'
    });
  } catch {
    return iso.length > 5 ? iso.slice(11, 16) : iso;
  }
}

function mapFlightAwareStatus(s: string): FlightData['status'] {
  const m: Record<string, FlightData['status']> = {
    'Scheduled': 'scheduled', 'En Route/On Time': 'active',
    'En Route/Late': 'active', 'Arrived/On Time': 'landed',
    'Arrived/Late': 'landed', 'Cancelled': 'cancelled',
    'Delayed': 'delayed',
  };
  return m[s] || 'unknown';
}

function mapFlightstatsStatus(s: string): FlightData['status'] {
  const m: Record<string, FlightData['status']> = {
    'ON_TIME': 'scheduled', 'EARLY': 'active', 'LATE': 'delayed',
    'ARRIVED': 'landed', 'CANCELED': 'cancelled', 'ACTIVE': 'active',
  };
  return m[s] || 'unknown';
}

function inferAirline(code: string): string {
  const prefix = code.match(/^[A-Z]{2,3}/)?.[0] || '';
  const airlines: Record<string, string> = {
    'IB': 'Iberia', 'VY': 'Vueling', 'VLG': 'Vueling',
    'LH': 'Lufthansa', 'KL': 'KLM', 'BA': 'British Airways',
    'FR': 'Ryanair', 'U2': 'easyJet', 'AF': 'Air France',
    'AZ': 'ITA Airways', 'BT': 'airBaltic',
  };
  return airlines[prefix] || prefix;
}
