/**
 * Result ranking tests for searchLocations (city search path only).
 *
 * The sort contract in geocode.ts:
 *   1. Exact BASENAME matches (city === query) always rank before partial matches.
 *   2. Within each group, larger AREALAND ranks first (used as a population proxy).
 *   3. Results are capped at 8.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../geocode', async () => {
  const actual = await vi.importActual<typeof import('../geocode')>('../geocode')
  return actual
})

import { searchLocations } from '../geocode'

// ─── helpers ──────────────────────────────────────────────────────────────────

type PlaceRow = {
  BASENAME: string
  NAME: string
  STATE: string
  CENTLAT: string
  CENTLON: string
  AREALAND: string
}

function makeFeatures(rows: PlaceRow[]) {
  return rows.map((r) => ({ attributes: r }))
}

/**
 * Mocks both Places_CouSub layers:
 *   layer4Features — returned for MapServer/4
 *   layer5Features — returned for MapServer/5 (default: empty)
 */
function mockCitySearch(layer4Features: PlaceRow[], layer5Features: PlaceRow[] = []) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input.toString())

    // Ignore ZCTA calls (ZIP path) — should never fire for city queries
    if (url.href.includes('PUMA_TAD_TAZ_UGA_ZCTA')) {
      return { ok: true, json: async () => ({ features: [] }) } as Response
    }

    if (url.href.includes('MapServer/4')) {
      return { ok: true, json: async () => ({ features: makeFeatures(layer4Features) }) } as Response
    }
    if (url.href.includes('MapServer/5')) {
      return { ok: true, json: async () => ({ features: makeFeatures(layer5Features) }) } as Response
    }

    return { ok: true, json: async () => ({ features: [] }) } as Response
  })
}

function place(
  basename: string,
  stateFips: string,
  arealand: number,
  lat = '40.0',
  lon = '-75.0',
): PlaceRow {
  return {
    BASENAME: basename,
    NAME: basename,
    STATE: stateFips,
    CENTLAT: lat,
    CENTLON: lon,
    AREALAND: String(arealand),
  }
}

beforeEach(() => vi.restoreAllMocks())

// ─── Suite 1: Exact match before partial ──────────────────────────────────────

describe('exact match ranks before partial match', () => {
  it('exact "Austin" ranks above larger-area "Austintown"', async () => {
    mockCitySearch([
      place('Austintown', '39', 90_000_000), // partial, bigger area
      place('Austin',     '48', 10_000_000), // exact, smaller area
    ])

    const results = await searchLocations('Austin')
    expect(results[0].matchedAddress).toBe('Austin, TX')
    expect(results[1].matchedAddress).toBe('Austintown, OH')
  })

  it('exact match comes first even when it appears last in API response', async () => {
    mockCitySearch([
      place('Portland Hills', '06',  5_000_000),
      place('Portland',       '41', 50_000_000),
    ])

    const results = await searchLocations('Portland')
    expect(results[0].matchedAddress).toBe('Portland, OR')
    expect(results[1].matchedAddress).toBe('Portland Hills, CA')
  })

  it('multiple exact matches all precede all partial matches', async () => {
    mockCitySearch([
      place('Springfield Township', '39', 999_999_999), // partial — very large
      place('Springfield',          '17',  50_000_000), // exact
      place('Springfield',          '29',  30_000_000), // exact
      place('Springfield',          '25',  20_000_000), // exact
    ])

    const results = await searchLocations('Springfield')
    const addresses = results.map((r) => r.matchedAddress)

    // All three exact matches come before the partial
    const partialIdx = addresses.indexOf('Springfield Township, OH')
    expect(partialIdx).toBeGreaterThan(addresses.indexOf('Springfield, IL'))
    expect(partialIdx).toBeGreaterThan(addresses.indexOf('Springfield, MO'))
    expect(partialIdx).toBeGreaterThan(addresses.indexOf('Springfield, MA'))
  })
})

// ─── Suite 2: Larger area ranks first within same exactness group ─────────────

describe('larger area ranks first within the same exactness group', () => {
  it('among exact matches, largest area is first', async () => {
    mockCitySearch([
      place('Portland', '23',  15_000_000), // Portland, ME — smaller
      place('Portland', '41', 145_000_000), // Portland, OR — larger
    ])

    const results = await searchLocations('Portland')
    expect(results[0].matchedAddress).toBe('Portland, OR')
    expect(results[1].matchedAddress).toBe('Portland, ME')
  })

  it('among partial matches, largest area is first', async () => {
    mockCitySearch([
      place('Portsmouth', '33',  40_000_000), // smaller
      place('Portsmouth', '23',  20_000_000), // smaller still
      place('Port Arthur', '48', 280_000_000), // largest
    ])

    const results = await searchLocations('Port')
    expect(results[0].matchedAddress).toBe('Port Arthur, TX')
    expect(results[1].matchedAddress).toBe('Portsmouth, NH')
    expect(results[2].matchedAddress).toBe('Portsmouth, ME')
  })

  it('three cities in descending area order remain in that order', async () => {
    mockCitySearch([
      place('Franklin', '47',  40_000_000), // TN — medium
      place('Franklin', '25', 150_000_000), // MA — largest
      place('Franklin', '55',  10_000_000), // WI — smallest
    ])

    const results = await searchLocations('Franklin')
    expect(results[0].matchedAddress).toBe('Franklin, MA')
    expect(results[1].matchedAddress).toBe('Franklin, TN')
    expect(results[2].matchedAddress).toBe('Franklin, WI')
  })
})

// ─── Suite 3: Result cap ──────────────────────────────────────────────────────

describe('result cap at 8', () => {
  it('returns at most 8 results even when API returns more', async () => {
    // 6 from layer 4, 5 from layer 5 = 11 total before dedup/cap
    mockCitySearch(
      Array.from({ length: 6 }, (_, i) =>
        place('Springfield', String(i).padStart(2, '0'), (10 - i) * 1_000_000),
      ),
      Array.from({ length: 5 }, (_, i) =>
        place('Springfield', String(i + 10).padStart(2, '0'), (5 - i) * 1_000_000),
      ),
    )

    const results = await searchLocations('Springfield')
    expect(results.length).toBeLessThanOrEqual(8)
  })

  it('returns all results when fewer than 8 are available', async () => {
    mockCitySearch([
      place('Salem', '41', 50_000_000),
      place('Salem', '25', 30_000_000),
      place('Salem', '51', 20_000_000),
    ])

    const results = await searchLocations('Salem')
    expect(results).toHaveLength(3)
  })
})

// ─── Suite 4: Deduplication ───────────────────────────────────────────────────

describe('deduplication across layers 4 and 5', () => {
  it('same city from both layers appears only once', async () => {
    mockCitySearch(
      [place('Menlo Park', '06', 100_000_000)],
      [place('Menlo Park', '06',  80_000_000)], // same matchedAddress from layer 5
    )

    const results = await searchLocations('Menlo Park')
    const menlo = results.filter((r) => r.matchedAddress === 'Menlo Park, CA')
    expect(menlo).toHaveLength(1)
  })

  it('same city name in different states is NOT deduplicated', async () => {
    mockCitySearch([
      place('Salem', '41', 50_000_000), // OR
      place('Salem', '25', 30_000_000), // MA
    ])

    const results = await searchLocations('Salem')
    const addresses = results.map((r) => r.matchedAddress)
    expect(addresses).toContain('Salem, OR')
    expect(addresses).toContain('Salem, MA')
  })
})
