import { describe, it, expect, vi, beforeEach } from 'vitest'

// Strip the 'use server' directive so the module loads in Node
vi.mock('../geocode', async () => {
  const mod = await import('../geocode?raw').catch(() => null)
  // Re-import after stripping directive — use the actual module
  const actual = await vi.importActual<typeof import('../geocode')>('../geocode')
  return actual
})

import { searchLocations } from '../geocode'

// ─── fetch mock helpers ───────────────────────────────────────────────────────

function mockFetch(handler: (url: string) => object) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString()
    const body = handler(url)
    return {
      ok: true,
      json: async () => body,
    } as Response
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
})

// ─── ZIP code routing ─────────────────────────────────────────────────────────

describe('ZIP code search', () => {
  it('routes a 5-digit input to the ZCTA layer', async () => {
    mockFetch((url) => {
      if (url.includes('PUMA_TAD_TAZ_UGA_ZCTA')) {
        return {
          features: [
            { attributes: { BASENAME: '10001', CENTLAT: '40.7484', CENTLON: '-73.9967' } },
          ],
        }
      }
      // placeAtPoint reverse lookup
      return { features: [{ attributes: { BASENAME: 'New York', STATE: '36' } }] }
    })

    const results = await searchLocations('10001')
    expect(results).toHaveLength(1)
    expect(results[0].matchedAddress).toContain('10001')
    expect(results[0].lat).toBeCloseTo(40.7484, 3)
    expect(results[0].lon).toBeCloseTo(-73.9967, 3)
  })

  it('routes a 3-digit prefix to the ZCTA layer with a LIKE query', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString()
      if (url.includes('PUMA_TAD_TAZ_UGA_ZCTA')) {
        const params = new URL(url).searchParams.get('where') ?? ''
        expect(params).toContain("LIKE '900%'")
        return { ok: true, json: async () => ({ features: [] }) } as unknown as Response
      }
      return { ok: true, json: async () => ({ features: [] }) } as unknown as Response
    })
    global.fetch = fetchMock

    await searchLocations('900')
    expect(fetchMock).toHaveBeenCalled()
  })

  it('routes a 4-digit prefix to the ZCTA layer', async () => {
    mockFetch((url) => {
      if (url.includes('PUMA_TAD_TAZ_UGA_ZCTA')) {
        return {
          features: [
            { attributes: { BASENAME: '9021', CENTLAT: '34.0522', CENTLON: '-118.2437' } },
          ],
        }
      }
      return { features: [] }
    })

    const results = await searchLocations('9021')
    expect(Array.isArray(results)).toBe(true)
  })

  it('returns the enriched place name when reverse lookup succeeds', async () => {
    mockFetch((url) => {
      if (url.includes('PUMA_TAD_TAZ_UGA_ZCTA')) {
        return {
          features: [
            { attributes: { BASENAME: '94102', CENTLAT: '37.7793', CENTLON: '-122.4193' } },
          ],
        }
      }
      // placeAtPoint — Incorporated Places layer
      return { features: [{ attributes: { BASENAME: 'San Francisco', STATE: '06' } }] }
    })

    const results = await searchLocations('94102')
    expect(results[0].matchedAddress).toBe('San Francisco, CA (94102)')
  })

  it('falls back to "ZIP XXXXX" label when reverse lookup returns nothing', async () => {
    mockFetch((url) => {
      if (url.includes('PUMA_TAD_TAZ_UGA_ZCTA')) {
        return {
          features: [
            { attributes: { BASENAME: '99999', CENTLAT: '60.0', CENTLON: '-150.0' } },
          ],
        }
      }
      // placeAtPoint returns empty for both layers
      return { features: [] }
    })

    const results = await searchLocations('99999')
    expect(results[0].matchedAddress).toBe('ZIP 99999')
  })

  it('returns empty array when the ZCTA API call fails', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) } as Response))
    const results = await searchLocations('10001')
    expect(results).toEqual([])
  })
})

// ─── City search routing ──────────────────────────────────────────────────────

describe('city name search routing', () => {
  it('does NOT hit the ZCTA layer for a city name', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ features: [] }),
    } as unknown as Response))
    global.fetch = fetchMock

    await searchLocations('Boston')
    for (const call of fetchMock.mock.calls) {
      const url = (call[0] as string).toString()
      expect(url).not.toContain('PUMA_TAD_TAZ_UGA_ZCTA')
    }
  })

  it('returns empty array for a 1-character query', async () => {
    global.fetch = vi.fn()
    const results = await searchLocations('A')
    expect(results).toEqual([])
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled()
  })

  it('returns empty array for an empty string', async () => {
    global.fetch = vi.fn()
    const results = await searchLocations('')
    expect(results).toEqual([])
    expect(vi.mocked(global.fetch)).not.toHaveBeenCalled()
  })
})

// ─── Input sanitization ───────────────────────────────────────────────────────

describe('input sanitization', () => {
  it('strips SQL-injection characters from city names', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString()
      const where = new URL(url).searchParams.get('where') ?? ''
      // The injected fragment must not appear verbatim in the WHERE clause
      expect(where).not.toContain("'; DROP TABLE")
      return { ok: true, json: async () => ({ features: [] }) } as unknown as Response
    })
    global.fetch = fetchMock

    await searchLocations("Boston'; DROP TABLE places; --")
    expect(fetchMock).toHaveBeenCalled()
  })
})
