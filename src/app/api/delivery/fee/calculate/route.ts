import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { calculateDeliveryFeeForAccount } from '@/lib/delivery/fee-engine'

/**
 * POST /api/delivery/fee/calculate  (any member)
 *
 * Session-authed calculation used by the manual order form's
 * "Calcular" button — pre-fills the delivery fee field, which staff
 * can still freely override afterward (never blocks a manual sale,
 * same carve-out business hours already has for staff-created orders).
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await getCurrentAccount()

    const limit = checkRateLimit(`delivery-fee-calculate:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const address = typeof body.address === 'string' ? body.address : undefined
    const neighborhoodName = typeof body.neighborhood_name === 'string' ? body.neighborhood_name : undefined
    const subtotal = typeof body.subtotal === 'number' && Number.isFinite(body.subtotal) ? body.subtotal : 0

    const result = await calculateDeliveryFeeForAccount(supabase, accountId, {
      address,
      neighborhoodName,
      subtotal,
    })

    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}
