import { NextResponse, after } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { reconcileInvoice } from '@/lib/billing/invoices'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

function getClientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  const xri = request.headers.get('x-real-ip')
  if (xri) return xri.trim()
  return 'unknown'
}

/**
 * POST /api/billing/webhook
 *
 * InfinitePay documents no webhook signature scheme (unlike the
 * Mercado Pago webhook in this codebase, which HMAC-verifies). The
 * body here is therefore treated as nothing more than a "something
 * changed, go check" hint — `reconcileInvoice` re-queries InfinitePay
 * directly via `payment_check` and is the only thing that ever
 * writes `status='paid'`. Never trust `order_nsu`/`paid_amount`/etc
 * from this body for anything beyond "which invoice to re-check."
 *
 * Because there's no signature, this endpoint is a public write with
 * zero authentication — rate-limited per IP, and unknown order_nsu
 * values are acked as 200 WITHOUT calling out to InfinitePay (so a
 * probe can't tell a real invoice id from a made-up one, and can't
 * use this endpoint to burn outbound API calls for free).
 */
export async function POST(request: Request) {
  const ip = getClientIp(request)
  const limit = checkRateLimit(`billing-webhook:${ip}`, RATE_LIMITS.billingWebhook)
  if (!limit.success) return rateLimitResponse(limit)

  const rawBody = await request.text()
  let orderNsu: string | null = null
  try {
    const parsed = JSON.parse(rawBody) as { order_nsu?: string; invoice_slug?: string }
    orderNsu = parsed.order_nsu ?? parsed.invoice_slug ?? null
  } catch {
    orderNsu = null
  }
  if (!orderNsu) {
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

  const admin = supabaseAdmin()
  const { data: invoice } = await admin
    .from('invoices')
    .select('id')
    .eq('checkout_order_nsu', orderNsu)
    .in('status', ['pending', 'overdue'])
    .maybeSingle()

  if (!invoice) {
    // Deliberately the same response as the "verified, found" path
    // below — never reveal whether an order_nsu is real.
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

  after(async () => {
    try {
      await reconcileInvoice(admin, invoice.id)
    } catch (err) {
      console.error('[billing-webhook] reconcile error:', err)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}
