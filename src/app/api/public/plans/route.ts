// ============================================================
// GET /api/public/plans
//
// Public — no auth required. Backs the /pricing page.
//
// Same shape as /api/public/menu/[slug]/route.ts: service-role read
// (plans has RLS enabled with zero policies — no client can read it
// any other way), hand-built response fields only (never a raw table
// row), so nothing internal (is_active, position, a private plan)
// leaks by accident.
// ============================================================

import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

function getClientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  const xri = request.headers.get('x-real-ip')
  if (xri) return xri.trim()
  return 'unknown'
}

export async function GET(request: Request) {
  const ip = getClientIp(request)
  const limit = checkRateLimit(`public-plans-read:${ip}`, RATE_LIMITS.publicPlansRead)
  if (!limit.success) return rateLimitResponse(limit)

  const { data, error } = await supabaseAdmin()
    .from('plans')
    .select('id, name, description, price_cents, currency, billing_cycle, max_users, enabled_modules')
    .eq('is_public', true)
    .eq('is_active', true)
    .order('position', { ascending: true })

  if (error) {
    console.error('[public/plans GET] fetch error:', error)
    return NextResponse.json({ error: 'Failed to load plans' }, { status: 500 })
  }

  return NextResponse.json({ plans: data ?? [] })
}
