/**
 * Location-accuracy tests for geocode.ts
 *
 * These tests verify that every Census TIGERweb API call carries exactly the
 * right identifiers for the place being searched:
 *   - ZIP searches → exact BASENAME value in the WHERE clause
 *   - Coordinate passthrough → placeAtPoint receives the centroid the ZCTA
 *     layer returned, not some default or corrupted value
 *   - City+state searches → correct state FIPS code in the WHERE clause
 *   - Layer fallback → placeAtPoint tries layer 4 before layer 5
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../geocode', async () => {
  const actual = await vi.importActual<typeof import('../geocode')>('../geocode')
  return actual
})

import { searchLocations } from '../geocode'

// ─── helpers ──────────────────────────────────────────────────────────────────

type FetchHandler = (url: URL) => { ok: boolean; body: object }

function interceptFetch(handler: FetchHandler) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input.toString())
    const { ok, body } = handler(url)
    return { ok, json: async () => body } as Response
  })
}

/** Captured URL objects for every fetch call during a test. */
function captureFetch(responses: Record<string, object>) {
  const calls: URL[] = []
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input.toString())
    calls.push(url)
    for (const [key, body] of Object.entries(responses)) {
      if (url.href.includes(key)) return { ok: true, json: async () => body } as Response
    }
    return { ok: true, json: async () => ({ features: [] }) } as Response
  })
  return calls
}

beforeEach(() => vi.restoreAllMocks())

// ─── Suite 1: ZIP WHERE clause precision ─────────────────────────────────────
//
// The Census ZCTA layer expects:
//   exact 5-digit  →  BASENAME='XXXXX'   (equality, no wildcard)
//   3-4 digit prefix → BASENAME LIKE 'XXX%'

describe('ZIP WHERE clause precision', () => {
  async function whereForZip(zip: string): Promise<string> {
    const calls = captureFetch({
      PUMA_TAD_TAZ_UGA_ZCTA: { features: [] },
    })
    await searchLocations(zip)
    const zcta = calls.find((u) => u.href.includes('PUMA_TAD_TAZ_UGA_ZCTA'))
    return zcta?.searchParams.get('where') ?? ''
  }

  it('10001 → exact equality, no wildcard', async () => {
    expect(await whereForZip('10001')).toBe("BASENAME='10001'")
  })

  it('90210 → exact equality, no wildcard', async () => {
    expect(await whereForZip('90210')).toBe("BASENAME='90210'")
  })

  it('60601 → exact equality, no wildcard', async () => {
    expect(await whereForZip('60601')).toBe("BASENAME='60601'")
  })

  it('78701 → exact equality, no wildcard', async () => {
    expect(await whereForZip('78701')).toBe("BASENAME='78701'")
  })

  it('3-digit prefix 100 → LIKE with wildcard', async () => {
    const where = await whereForZip('100')
    expect(where).toBe("BASENAME LIKE '100%'")
  })

  it('4-digit prefix 9021 → LIKE with wildcard', async () => {
    const where = await whereForZip('9021')
    expect(where).toBe("BASENAME LIKE '9021%'")
  })

  it('4-digit prefix 0260 → LIKE (leading zero preserved)', async () => {
    const where = await whereForZip('0260')
    expect(where).toBe("BASENAME LIKE '0260%'")
  })
})

// ─── Suite 2: Coordinate passthrough to reverse lookup ───────────────────────
//
// Whatever lat/lon the ZCTA layer returns must appear verbatim in the
// geometry param of the placeAtPoint call.  No rounding, no defaults.

describe('coordinate passthrough to placeAtPoint', () => {
  function zipFixture(zip: string, lat: string, lon: string, city: string, stateFips: string) {
    const calls: URL[] = []
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString())
      calls.push(url)

      if (url.href.includes('PUMA_TAD_TAZ_UGA_ZCTA')) {
        return {
          ok: true,
          json: async () => ({
            features: [{ attributes: { BASENAME: zip, CENTLAT: lat, CENTLON: lon } }],
          }),
        } as Response
      }

      // placeAtPoint reverse lookup
      return {
        ok: true,
        json: async () => ({
          features: [{ attributes: { BASENAME: city, STATE: stateFips } }],
        }),
      } as Response
    })
    return calls
  }

  it('10001 (Chelsea/Manhattan): centroid forwarded exactly to reverse lookup', async () => {
    const LAT = '40.74839'
    const LON = '-73.99673'
    const calls = zipFixture('10001', LAT, LON, 'New York', '36')

    await searchLocations('10001')

    const reverseCall = calls.find(
      (u) => u.href.includes('Places_CouSub') && u.searchParams.has('geometry'),
    )
    expect(reverseCall).toBeDefined()
    // geometry param is "lon,lat"
    expect(reverseCall!.searchParams.get('geometry')).toBe(`${LON},${LAT}`)
  })

  it('90210 (Beverly Hills): centroid forwarded exactly to reverse lookup', async () => {
    const LAT = '34.08819'
    const LON = '-118.40612'
    const calls = zipFixture('90210', LAT, LON, 'Beverly Hills', '06')

    await searchLocations('90210')

    const reverseCall = calls.find(
      (u) => u.href.includes('Places_CouSub') && u.searchParams.has('geometry'),
    )
    expect(reverseCall!.searchParams.get('geometry')).toBe(`${LON},${LAT}`)
  })

  it('60601 (Chicago Loop): centroid forwarded exactly to reverse lookup', async () => {
    // Use a value without trailing zeros — parseFloat strips them before building the geometry param
    const LAT = '41.88591'
    const LON = '-87.61956'
    const calls = zipFixture('60601', LAT, LON, 'Chicago', '17')

    await searchLocations('60601')

    const reverseCall = calls.find(
      (u) => u.href.includes('Places_CouSub') && u.searchParams.has('geometry'),
    )
    expect(reverseCall!.searchParams.get('geometry')).toBe(`${LON},${LAT}`)
  })

  it('multiple ZIPs: each gets its own placeAtPoint call with distinct coords', async () => {
    // Avoid trailing zeros — parseFloat strips them before building the geometry param
    const zips = [
      { zip: '02101', lat: '42.35991', lon: '-71.05888' }, // Boston
      { zip: '98101', lat: '47.60621', lon: '-122.33207' }, // Seattle
    ]

    const reverseLookupGeometries: string[] = []
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString())

      if (url.href.includes('PUMA_TAD_TAZ_UGA_ZCTA')) {
        return {
          ok: true,
          json: async () => ({
            features: zips.map((z) => ({
              attributes: { BASENAME: z.zip, CENTLAT: z.lat, CENTLON: z.lon },
            })),
          }),
        } as Response
      }

      const geom = url.searchParams.get('geometry')
      if (geom) reverseLookupGeometries.push(geom)
      return { ok: true, json: async () => ({ features: [] }) } as Response
    })

    await searchLocations('021') // 3-digit prefix → hits the ZIP path (regex requires ≥ 3 digits)
    // placeAtPoint tries layer 4 then layer 5 per ZIP → 2 ZIPs × 2 layers = 4 calls total.
    // What matters: both ZIP centroids appear, and they are distinct.
    const unique = new Set(reverseLookupGeometries)
    expect(unique.size).toBeGreaterThanOrEqual(2)
    expect(reverseLookupGeometries).toContain(`${zips[0].lon},${zips[0].lat}`)
    expect(reverseLookupGeometries).toContain(`${zips[1].lon},${zips[1].lat}`)
  })
})

// ─── Suite 3: Known ZIP → expected city + state label ────────────────────────
//
// End-to-end label assembly: ZCTA centroid → placeAtPoint → matchedAddress.

describe('known ZIP → expected city/state label', () => {
  function fixture(
    zip: string,
    lat: string,
    lon: string,
    city: string,
    fips: string,
    stateAbbr: string,
  ) {
    return async () => {
      interceptFetch((url) => {
        if (url.href.includes('PUMA_TAD_TAZ_UGA_ZCTA'))
          return {
            ok: true,
            body: { features: [{ attributes: { BASENAME: zip, CENTLAT: lat, CENTLON: lon } }] },
          }
        // placeAtPoint
        return { ok: true, body: { features: [{ attributes: { BASENAME: city, STATE: fips } }] } }
      })

      const results = await searchLocations(zip)
      expect(results).toHaveLength(1)
      expect(results[0].matchedAddress).toBe(`${city}, ${stateAbbr} (${zip})`)
      expect(results[0].lat).toBeCloseTo(parseFloat(lat), 3)
      expect(results[0].lon).toBeCloseTo(parseFloat(lon), 3)
    }
  }

  it('10001 → New York, NY (10001)',
    fixture('10001', '40.74839', '-73.99673', 'New York', '36', 'NY'))

  it('90210 → Beverly Hills, CA (90210)',
    fixture('90210', '34.08819', '-118.40612', 'Beverly Hills', '06', 'CA'))

  it('60601 → Chicago, IL (60601)',
    fixture('60601', '41.88590', '-87.61956', 'Chicago', '17', 'IL'))

  it('78701 → Austin, TX (78701)',
    fixture('78701', '30.27357', '-97.74036', 'Austin', '48', 'TX'))

  it('02101 → Boston, MA (02101)',
    fixture('02101', '42.35990', '-71.05888', 'Boston', '25', 'MA'))

  it('98101 → Seattle, WA (98101)',
    fixture('98101', '47.60621', '-122.33207', 'Seattle', '53', 'WA'))

  it('30301 → Atlanta, GA (30301)',
    fixture('30301', '33.74900', '-84.38798', 'Atlanta', '13', 'GA'))

  it('77001 → Houston, TX (77001)',
    fixture('77001', '29.75523', '-95.36709', 'Houston', '48', 'TX'))
})

// ─── Suite 4: City + state → correct FIPS in WHERE clause ────────────────────
//
// parseQuery must map the state portion to the right FIPS code so the
// TIGERweb WHERE clause filters to exactly the right state.

describe('city+state → correct FIPS in WHERE clause', () => {
  async function fipsForQuery(query: string): Promise<string | null> {
    const calls: URL[] = []
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(new URL(input.toString()))
      return { ok: true, json: async () => ({ features: [] }) } as Response
    })
    await searchLocations(query)
    // Both layer 4 and 5 fire; grab the first Places_CouSub call
    const cityCall = calls.find((u) => u.href.includes('Places_CouSub'))
    const where = cityCall?.searchParams.get('where') ?? ''
    const match = where.match(/STATE='(\d+)'/)
    return match ? match[1] : null
  }

  // "City, ST" comma form
  it('"Austin, TX" → FIPS 48', async () => expect(await fipsForQuery('Austin, TX')).toBe('48'))
  it('"Boston, MA" → FIPS 25', async () => expect(await fipsForQuery('Boston, MA')).toBe('25'))
  it('"Seattle, WA" → FIPS 53', async () => expect(await fipsForQuery('Seattle, WA')).toBe('53'))
  it('"Chicago, IL" → FIPS 17', async () => expect(await fipsForQuery('Chicago, IL')).toBe('17'))
  it('"Denver, CO" → FIPS 08', async () => expect(await fipsForQuery('Denver, CO')).toBe('08'))
  it('"Miami, FL"  → FIPS 12', async () => expect(await fipsForQuery('Miami, FL')).toBe('12'))
  it('"Atlanta, GA" → FIPS 13', async () => expect(await fipsForQuery('Atlanta, GA')).toBe('13'))
  it('"Houston, TX" → FIPS 48', async () => expect(await fipsForQuery('Houston, TX')).toBe('48'))

  // Trailing abbreviation (no comma)
  it('"Portland OR" → FIPS 41', async () => expect(await fipsForQuery('Portland OR')).toBe('41'))
  it('"Portland ME" → FIPS 23', async () => expect(await fipsForQuery('Portland ME')).toBe('23'))

  // Full state name — comma form works for single-word state names; the
  // trailing-token parser only kicks in for ≥ 2-word state names (e.g. "West Virginia").
  it('"Portland, Oregon" → FIPS 41 (comma separates single-word state name)',
    async () => expect(await fipsForQuery('Portland, Oregon')).toBe('41'))
  it('"Salem West Virginia" → FIPS 54 (two-word state name parsed from trailing tokens)',
    async () => expect(await fipsForQuery('Salem West Virginia')).toBe('54'))

  // No state specified → no STATE clause
  it('"Springfield" (no state) → no FIPS filter', async () => {
    expect(await fipsForQuery('Springfield')).toBeNull()
  })
})

// ─── Suite 5: placeAtPoint layer fallback order ───────────────────────────────
//
// placeAtPoint must try Incorporated Places (layer 4) first; only fall back
// to Census Designated Places (layer 5) when layer 4 has no result.

describe('placeAtPoint layer fallback', () => {
  function setupZctaWithEmptyPlace(layer4Response: object, layer5Response: object) {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString())

      if (url.href.includes('PUMA_TAD_TAZ_UGA_ZCTA')) {
        return {
          ok: true,
          json: async () => ({
            features: [{ attributes: { BASENAME: '94027', CENTLAT: '37.4529', CENTLON: '-122.1817' } }],
          }),
        } as Response
      }

      // Distinguish layer 4 vs layer 5 in Places_CouSub URL
      if (url.href.includes('MapServer/4/query') && url.searchParams.has('geometry')) {
        return { ok: true, json: async () => layer4Response } as Response
      }
      if (url.href.includes('MapServer/5/query') && url.searchParams.has('geometry')) {
        return { ok: true, json: async () => layer5Response } as Response
      }

      return { ok: true, json: async () => ({ features: [] }) } as Response
    })
  }

  it('layer 4 succeeds → layer 5 never called for reverse lookup', async () => {
    setupZctaWithEmptyPlace(
      { features: [{ attributes: { BASENAME: 'Atherton', STATE: '06' } }] },
      { features: [{ attributes: { BASENAME: 'Should not appear', STATE: '06' } }] },
    )

    const results = await searchLocations('94027')
    expect(results[0].matchedAddress).toBe('Atherton, CA (94027)')

    // Count layer-5 geometry calls — should be zero
    const layer5GeomCalls = vi.mocked(global.fetch).mock.calls.filter((c) => {
      const url = new URL((c[0] as string).toString())
      return url.href.includes('MapServer/5/query') && url.searchParams.has('geometry')
    })
    expect(layer5GeomCalls).toHaveLength(0)
  })

  it('layer 4 returns empty → layer 5 is tried and its result is used', async () => {
    setupZctaWithEmptyPlace(
      { features: [] },
      { features: [{ attributes: { BASENAME: 'Menlo Park', STATE: '06' } }] },
    )

    const results = await searchLocations('94027')
    expect(results[0].matchedAddress).toBe('Menlo Park, CA (94027)')
  })

  it('both layers return empty → label falls back to "ZIP XXXXX"', async () => {
    setupZctaWithEmptyPlace({ features: [] }, { features: [] })

    const results = await searchLocations('94027')
    expect(results[0].matchedAddress).toBe('ZIP 94027')
  })
})
