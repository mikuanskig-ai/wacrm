import { describe, expect, it } from 'vitest'
import { isPreciseGeocode } from './distance-provider'

describe('isPreciseGeocode', () => {
  it('trusts venue/address/street layers', () => {
    expect(isPreciseGeocode('venue')).toBe(true)
    expect(isPreciseGeocode('address')).toBe(true)
    expect(isPreciseGeocode('street')).toBe(true)
  })

  it('flags coarser layers as imprecise — real failure mode: a specific street address falling back to a bare city match', () => {
    expect(isPreciseGeocode('locality')).toBe(false)
    expect(isPreciseGeocode('region')).toBe(false)
    expect(isPreciseGeocode('neighbourhood')).toBe(false)
    expect(isPreciseGeocode('country')).toBe(false)
  })

  it('flags a missing layer as imprecise rather than assuming the best', () => {
    expect(isPreciseGeocode(null)).toBe(false)
  })
})
