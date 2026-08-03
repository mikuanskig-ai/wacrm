import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getDistanceProvider } from '@/lib/delivery/providers/openrouteservice'
import { DistanceProviderError } from '@/lib/delivery/distance-provider'
import type { DeliveryMethod, DeliveryFeeSettings, NeighborhoodRule, DistanceRangeRule } from '@/lib/delivery/fee-engine'

const METHODS: DeliveryMethod[] = ['fixed', 'neighborhood', 'distance_range', 'per_km']
const GENERIC_GEOCODE_WARNING =
  'Could not resolve this address to a location. Distance-based methods will not work until it does.'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** Human-readable composition of the structured fields — display
 *  only, never re-geocoded directly (see migration 058). */
function composeOriginAddress(parts: {
  street: string | null
  neighbourhood: string | null
  city: string | null
  state: string | null
  postalCode: string | null
}): string | null {
  if (!parts.city) return null
  const cityState = parts.state ? `${parts.city} - ${parts.state}` : parts.city
  const line = [parts.street, parts.neighbourhood, cityState, parts.postalCode].filter(Boolean).join(', ')
  return line || null
}

/** Validates + normalizes the method-specific `settings` payload.
 *  Returns null on any shape mismatch — the caller turns that into a
 *  400 rather than persisting a half-formed config the engine would
 *  silently ignore later. */
function parseSettings(method: DeliveryMethod, input: unknown): DeliveryFeeSettings | null {
  if (typeof input !== 'object' || input === null) return null
  const raw = input as Record<string, unknown>

  switch (method) {
    case 'fixed': {
      if (!isFiniteNumber(raw.fixed_price) || raw.fixed_price < 0) return null
      return { fixed_price: raw.fixed_price }
    }
    case 'neighborhood': {
      if (!Array.isArray(raw.neighborhoods)) return null
      const neighborhoods: NeighborhoodRule[] = []
      for (const entry of raw.neighborhoods) {
        if (typeof entry !== 'object' || entry === null) return null
        const { id, name, price } = entry as Record<string, unknown>
        if (typeof id !== 'string' || !id) return null
        if (typeof name !== 'string' || !name.trim()) return null
        if (!isFiniteNumber(price) || price < 0) return null
        neighborhoods.push({ id, name: name.trim(), price })
      }
      return { neighborhoods }
    }
    case 'distance_range': {
      if (!Array.isArray(raw.rules)) return null
      const rules: DistanceRangeRule[] = []
      for (const entry of raw.rules) {
        if (typeof entry !== 'object' || entry === null) return null
        const { from, to, price } = entry as Record<string, unknown>
        if (!isFiniteNumber(from) || from < 0) return null
        if (!isFiniteNumber(to) || to <= from) return null
        if (!isFiniteNumber(price) || price < 0) return null
        rules.push({ from, to, price })
      }
      return { rules }
    }
    case 'per_km': {
      if (!isFiniteNumber(raw.base_price) || raw.base_price < 0) return null
      if (!isFiniteNumber(raw.price_per_km) || raw.price_per_km < 0) return null
      return { base_price: raw.base_price, price_per_km: raw.price_per_km }
    }
  }
}

const ORIGIN_SELECT =
  'delivery_method, max_distance, free_shipping_above, origin_address, origin_street, origin_neighbourhood, origin_city, origin_state, origin_postal_code, origin_lat, origin_lng, origin_resolved_label, settings'

/**
 * GET /api/delivery/fee-config
 *
 * Any member may read the config so the UI can reflect the active
 * method (mirrors business-hours' "any member reads" split).
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data, error } = await supabase
      .from('delivery_fee_configs')
      .select(ORIGIN_SELECT)
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[delivery/fee-config GET] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load delivery fee config' }, { status: 500 })
    }

    if (!data) return NextResponse.json({ configured: false })
    return NextResponse.json({ configured: true, ...data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/delivery/fee-config  (admin+)
 *
 * Upserts the account's delivery-fee config. The origin address is
 * structured (street/neighbourhood/city/state/postal code), not a
 * free-text blob — a single string wasn't enough for the geocoder to
 * reliably resolve small Brazilian towns (observed live: a same-named
 * street matched in a completely different state). When any origin
 * field changes, geocodes via the structured endpoint here (once) so
 * per-order calculations never re-resolve the restaurant's own
 * address — see fee-engine.ts. A geocode failure never blocks the
 * save; the response carries a warning + whatever label the provider
 * DID resolve to (even on success) so the admin can visually confirm
 * it's the right place, not just trust it silently.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`delivery-fee-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const method = body.delivery_method
    if (!METHODS.includes(method)) return bad('delivery_method must be one of: ' + METHODS.join(', '))

    const settings = parseSettings(method, body.settings)
    if (!settings) return bad('settings does not match the shape required by delivery_method')

    const maxDistance =
      body.max_distance === null || body.max_distance === undefined ? null : Number(body.max_distance)
    if (maxDistance !== null && (!isFiniteNumber(maxDistance) || maxDistance <= 0)) {
      return bad('max_distance must be a positive number or null')
    }

    const freeShippingAbove =
      body.free_shipping_above === null || body.free_shipping_above === undefined
        ? null
        : Number(body.free_shipping_above)
    if (freeShippingAbove !== null && (!isFiniteNumber(freeShippingAbove) || freeShippingAbove < 0)) {
      return bad('free_shipping_above must be a non-negative number or null')
    }

    const originStreet = str(body.origin_street)
    const originNeighbourhood = str(body.origin_neighbourhood)
    const originCity = str(body.origin_city)
    const originState = str(body.origin_state)
    const originPostalCode = str(body.origin_postal_code)
    if ((originStreet || originNeighbourhood || originState || originPostalCode) && !originCity) {
      return bad('origin_city is required when any other origin field is set')
    }

    const { data: existing } = await supabase
      .from('delivery_fee_configs')
      .select(
        'origin_street, origin_neighbourhood, origin_city, origin_state, origin_postal_code, origin_lat, origin_lng, origin_resolved_label',
      )
      .eq('account_id', accountId)
      .maybeSingle()

    let originLat = existing?.origin_lat ?? null
    let originLng = existing?.origin_lng ?? null
    let originResolvedLabel = existing?.origin_resolved_label ?? null
    let geocodeWarning: string | null = null

    const originChanged =
      originStreet !== (existing?.origin_street ?? null) ||
      originNeighbourhood !== (existing?.origin_neighbourhood ?? null) ||
      originCity !== (existing?.origin_city ?? null) ||
      originState !== (existing?.origin_state ?? null) ||
      originPostalCode !== (existing?.origin_postal_code ?? null)

    if (originChanged) {
      if (!originCity) {
        originLat = null
        originLng = null
        originResolvedLabel = null
      } else {
        try {
          const result = await getDistanceProvider().geocodeStructured({
            address: originStreet ?? undefined,
            neighbourhood: originNeighbourhood ?? undefined,
            locality: originCity,
            region: originState ?? undefined,
            postalCode: originPostalCode ?? undefined,
          })
          if (result) {
            originLat = result.lat
            originLng = result.lng
            originResolvedLabel = result.label
          } else {
            originLat = null
            originLng = null
            originResolvedLabel = null
            geocodeWarning = GENERIC_GEOCODE_WARNING
          }
        } catch (err) {
          originLat = null
          originLng = null
          originResolvedLabel = null
          geocodeWarning = err instanceof DistanceProviderError ? err.message : GENERIC_GEOCODE_WARNING
        }
      }
    }

    const originAddress = composeOriginAddress({
      street: originStreet,
      neighbourhood: originNeighbourhood,
      city: originCity,
      state: originState,
      postalCode: originPostalCode,
    })

    const shared = {
      delivery_method: method,
      max_distance: maxDistance,
      free_shipping_above: freeShippingAbove,
      origin_address: originAddress,
      origin_street: originStreet,
      origin_neighbourhood: originNeighbourhood,
      origin_city: originCity,
      origin_state: originState,
      origin_postal_code: originPostalCode,
      origin_resolved_label: originResolvedLabel,
      origin_lat: originLat,
      origin_lng: originLng,
      settings,
    }

    if (existing) {
      const { error: upErr } = await supabase
        .from('delivery_fee_configs')
        .update(shared)
        .eq('account_id', accountId)
      if (upErr) {
        console.error('[delivery/fee-config POST] update error:', upErr)
        return NextResponse.json({ error: 'Failed to save delivery fee config' }, { status: 500 })
      }
    } else {
      const { error: insErr } = await supabase.from('delivery_fee_configs').insert({
        account_id: accountId,
        ...shared,
      })
      if (insErr) {
        console.error('[delivery/fee-config POST] insert error:', insErr)
        return NextResponse.json({ error: 'Failed to save delivery fee config' }, { status: 500 })
      }
    }

    return NextResponse.json({ success: true, geocodeWarning, resolvedLabel: originResolvedLabel })
  } catch (err) {
    return toErrorResponse(err)
  }
}
