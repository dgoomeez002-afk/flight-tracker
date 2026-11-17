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

// --- ADSB.lol (free, no API key, covers Spain well) ---
export async function scrapeAdsbLol(flightNumber: string): Promise<Partial<FlightData> | null> {
  try {
    const callsign = flightNumber.replace(/\s/g, '').toUpperCase();
    // Search by callsign
    const url = `https://api.adsb.lol/v2/callsign/${callsign}`;

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'FlightTracker/1.0 (https://flight-tracker-lime.vercel.app)',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return null;
    const data = await res.json();

    // Response: { ac: [ aircraft... ] }
    if (!data.ac || data.ac.length === 0) return null;

    const ac = data.ac[0];
    // Fields: lat, lon, alt_baro, gs (ground speed knots), track (heading),
    //         flight (callsign), r (registration), t (aircraft type), desc, dbFlags

    const onGround = ac.on_ground === true || ac.gnd === true || ac.alt_baro === 'ground';
    const altFt = typeof ac.alt_baro === 'number' ? ac.alt_baro : (typeof ac.alt_geom === 'number' ? ac.alt_geom : null);

    return {
      lat: ac.lat || null,
      lon: ac.lon || null,
      altitude: altFt ? `${Math.round(altFt).toLocaleString()} ft` : '—',
      speed: ac.gs ? `${Math.round(ac.gs)} kn` : '—',
      heading: ac.track ? `${Math.round(ac.track)}°` : '—',
      status: onGround ? 'active' : 'active',
      aircraft: ac.t || ac.desc || '',
      registration: ac.r || '',
      source: 'ADSB.lol',
    };
  } catch {
    return null;
  }
}

// --- airplanes.live (free, no API key, good Spain coverage) ---
export async function scrapeAirplanesLive(flightNumber: string): Promise<Partial<FlightData> | null> {
  try {
    const callsign = flightNumber.replace(/\s/g, '').toUpperCase();
    const url = `https://api.airplanes.live/v2/callsign/${callsign}`;

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'FlightTracker/1.0',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return null;
    const data = await res.json();
    if (!data.ac || data.ac.length === 0) return null;

    const ac = data.ac[0];
    const altFt = typeof ac.alt_baro === 'number' ? ac.alt_baro : (typeof ac.alt_geom === 'number' ? ac.alt_geom : null);

    return {
      lat: ac.lat || null,
      lon: ac.lon || null,
      altitude: altFt ? `${Math.round(altFt).toLocaleString()} ft` : '—',
      speed: ac.gs ? `${Math.round(ac.gs)} kn` : '—',
      heading: ac.track ? `${Math.round(ac.track)}°` : '—',
      status: 'active',
      aircraft: ac.t || ac.desc || '',
      registration: ac.r || '',
      source: 'airplanes.live',
    };
  } catch {
    return null;
  }
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
    const lon = state[5];
    const lat = state[6];
    const alt = state[7]; // meters
    const speed = state[9]; // m/s
    const heading = state[10];
    const onGround = state[8];

    return {
      lat,
      lon,
      altitude: alt ? `${Math.round(alt * 3.28084).toLocaleString()} ft` : '—',
      speed: speed ? `${Math.round(speed * 1.944)} kn` : '—',
      heading: heading ? `${Math.round(heading)}°` : '—',
      status: onGround ? 'active' : 'active',
      source: 'OpenSky Network',
    };
  } catch {
    return null;
  }
}

// --- OpenSky búsqueda por área (España + Baleares bounding box) ---
export async function scrapeOpenSkyArea(flightNumber: string): Promise<Partial<FlightData> | null> {
  try {
    // Bounding box que cubre España + Baleares + parte del Mediterráneo
    const url = `https://opensky-network.org/api/states/all?lamin=35.0&lomin=-10.0&lamax=44.5&lomax=5.0`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'FlightTracker/1.0' },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return null;
    const data = await res.json();
    if (!data.states) return null;

    const code = flightNumber.replace(/\s/g, '').toUpperCase();
    // Buscar callsign que contenga el número de vuelo (con o sin espacios)
    const state = data.states.find((s: unknown[]) => {
      const cs = String(s[1] || '').trim().toUpperCase();
      return cs === code || cs.startsWith(code) || code.startsWith(cs.replace(/\s/g, ''));
    });

    if (!state) return null;

    const lon = state[5];
    const lat = state[6];
    const alt = state[7];
    const speed = state[9];
    const heading = state[10];
    const onGround = state[8];

    return {
      lat,
      lon,
      altitude: alt ? `${Math.round(alt * 3.28084).toLocaleString()} ft` : '—',
      speed: speed ? `${Math.round(speed * 1.944)} kn` : '—',
      heading: heading ? `${Math.round(heading)}°` : '—',
      status: onGround ? 'active' : 'active',
      source: 'OpenSky (área)',
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
      altitude: f.last_position?.altitude ? `${f.last_position.altitude.toLocaleString()} ft` : '—',
      speed: f.last_position?.groundspeed ? `${f.last_position.groundspeed} kn` : '—',
      heading: f.last_position?.heading ? `${f.last_position.heading}°` : '—',
      source: 'FlightAware AeroAPI',
    };
  } catch {
    return null;
  }
}

// --- FlightStats scraper (mejorado con más headers) ---
export async function scrapeFlightStats(flightNumber: string): Promise<Partial<FlightData> | null> {
  try {
    const airline = flightNumber.match(/^[A-Z]+/)?.[0] || '';
    const number = flightNumber.match(/\d+/)?.[0] || '';
    const url = `https://www.flightstats.com/v2/flight-tracker/${airline}/${number}`;

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.8,en-US;q=0.5,en;q=0.3',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0',
      },
      signal: AbortSignal.timeout(12000),
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

// --- ADSBDB (datos de aeronave, sin posición en tiempo real) ---
export async function scrapeAdsbDb(flightNumber: string): Promise<Partial<FlightData> | null> {
  try {
    const callsign = flightNumber.replace(/\s/g, '').toUpperCase();
    const url = `https://api.adsbdb.com/v0/callsign/${callsign}`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'FlightTracker/1.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return null;
    const data = await res.json();

    // Response: { response: { flightroute: { ... }, aircraft: { ... } } }
    const route = data?.response?.flightroute;
    const aircraft = data?.response?.aircraft || route?.aircraft;

    if (!route && !aircraft) return null;

    const result: Partial<FlightData> = { source: 'ADSBDB' };

    if (aircraft) {
      result.aircraft = `${aircraft.manufacturer || ''} ${aircraft.type || ''}`.trim() || aircraft.icao_type || '';
      result.registration = aircraft.registration || '';
      result.airline = aircraft.registered_owner || '';
    }

    if (route) {
      result.departure = {
        iata: route.origin?.iata_code || '',
        name: route.origin?.name || '',
        city: route.origin?.municipality || '',
        scheduled: '', actual: null, estimated: null, gate: null, terminal: null,
      };
      result.arrival = {
        iata: route.destination?.iata_code || '',
        name: route.destination?.name || '',
        city: route.destination?.municipality || '',
        scheduled: '', actual: null, estimated: null, gate: null, terminal: null,
      };
      if (route.airline) {
        result.airline = route.airline.name || route.airline.icao || result.airline || '';
      }
    }

    return result;
  } catch {
    return null;
  }
}

// --- Merge results from multiple sources ---
export async function getFlightData(flightNumber: string): Promise<FlightData> {
  const code = flightNumber.toUpperCase().trim();

  // Run all scrapers in parallel
  const [adsbLol, airplanesLive, opensky, openskArea, aviationstack, flightaware, flightstats, adsbdb] = await Promise.allSettled([
    scrapeAdsbLol(code),
    scrapeAirplanesLive(code),
    scrapeOpenSky(code),
    scrapeOpenSkyArea(code),
    scrapeAviationStack(code),
    scrapeFlightAware(code),
    scrapeFlightStats(code),
    scrapeAdsbDb(code),
  ]);

  const results = [adsbLol, airplanesLive, opensky, openskArea, aviationstack, flightaware, flightstats, adsbdb]
    .map(r => r.status === 'fulfilled' ? r.value : null)
    .filter(Boolean) as Partial<FlightData>[];

  // Merge: prefer FlightAware > AviationStack > FlightStats > ADSBDB > OpenSky
  // (para datos estáticos como aeropuertos, horarios)
  const merged = results.reduce((acc, r) => ({ ...acc, ...r }), {} as Partial<FlightData>);

  // Priority para posición en tiempo real: ADSB.lol > airplanes.live > OpenSky área > OpenSky directo
  const livePos = [adsbLol, airplanesLive, openskArea, opensky]
    .map(r => r.status === 'fulfilled' ? r.value : null)
    .find(r => r?.lat != null);

  if (livePos?.lat) {
    merged.lat = livePos.lat;
    merged.lon = livePos.lon;
    merged.altitude = livePos.altitude || merged.altitude;
    merged.speed = livePos.speed || merged.speed;
    merged.heading = livePos.heading || merged.heading;
    merged.status = 'active';
  }

  const activeSources = results.map(r => r?.source).filter(Boolean).join(' + ') || 'Sin datos';

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
    source: activeSources,
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
    // España
    'IB': 'Iberia', 'IBE': 'Iberia',
    'VY': 'Vueling', 'VLG': 'Vueling',
    'I2': 'Iberia Express', 'IBS': 'Iberia Express',
    'ANE': 'Air Nostrum',
    'UX': 'Air Europa', 'AEA': 'Air Europa',
    'NT': 'Binter Canarias',
    'YW': 'Air Nostrum',
    // Europa
    'LH': 'Lufthansa', 'DLH': 'Lufthansa',
    'KL': 'KLM', 'KLM': 'KLM',
    'BA': 'British Airways', 'BAW': 'British Airways',
    'FR': 'Ryanair', 'RYR': 'Ryanair',
    'U2': 'easyJet', 'EZY': 'easyJet',
    'AF': 'Air France', 'AFR': 'Air France',
    'AZ': 'ITA Airways',
    'OS': 'Austrian Airlines',
    'SN': 'Brussels Airlines',
    'TP': 'TAP Air Portugal',
    'SK': 'SAS',
    'AY': 'Finnair',
    'LX': 'Swiss',
    'BT': 'airBaltic',
    'W6': 'Wizz Air',
    'V7': 'Volotea',
    'PC': 'Pegasus',
    'TK': 'Turkish Airlines', 'THY': 'Turkish Airlines',
    // Mundo
    'EK': 'Emirates', 'UAE': 'Emirates',
    'QR': 'Qatar Airways', 'QTR': 'Qatar Airways',
    'EY': 'Etihad Airways', 'ETD': 'Etihad Airways',
    'SQ': 'Singapore Airlines',
    'CX': 'Cathay Pacific',
    'NH': 'ANA',
    'JL': 'Japan Airlines',
    'AA': 'American Airlines', 'AAL': 'American Airlines',
    'DL': 'Delta Air Lines', 'DAL': 'Delta Air Lines',
    'UA': 'United Airlines', 'UAL': 'United Airlines',
    'AC': 'Air Canada',
    'QF': 'Qantas',
    'WN': 'Southwest Airlines',
    'WS': 'WestJet',
    'LA': 'LATAM', 'LAN': 'LATAM',
    'CM': 'Copa Airlines',
    'AV': 'Avianca',
    'AM': 'Aeromexico',
    'ET': 'Ethiopian Airlines',
    'MS': 'EgyptAir',
    'RJ': 'Royal Jordanian',
    'SV': 'Saudi Arabian Airlines',
    'FZ': 'flydubai',
    'G9': 'Air Arabia',
  };
  return airlines[prefix] || prefix;
}
