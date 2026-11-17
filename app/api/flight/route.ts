import { NextRequest, NextResponse } from 'next/server';
import { getFlightData } from '@/lib/scrapers';

// Cache: store last result per flight to avoid hammering scrapers
const cache = new Map<string, { data: unknown; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const flight = searchParams.get('flight')?.toUpperCase().trim();

  if (!flight || !/^[A-Z]{1,3}\d{1,4}[A-Z]?$/.test(flight)) {
    return NextResponse.json({ error: 'Número de vuelo inválido' }, { status: 400 });
  }

  // Check cache
  const cached = cache.get(flight);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json({ ...(cached.data as object), cached: true });
  }

  try {
    const data = await getFlightData(flight);
    cache.set(flight, { data, ts: Date.now() });
    return NextResponse.json(data);
  } catch (err) {
    console.error('Flight fetch error:', err);
    return NextResponse.json({ error: 'Error obteniendo datos del vuelo' }, { status: 500 });
  }
}

// Allow CORS for the frontend
export const runtime = 'nodejs';
