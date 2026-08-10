import { NextResponse } from 'next/server'
import { requirePlatformAdmin } from '@/lib/auth/platform-admin'
import { toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { OFFLINE_AFTER_MS } from '@/lib/presence'
import packageJson from '../../../../../package.json'

/**
 * GET /api/admin/stats  (platform admin only)
 *
 * Platform-wide business/usage counts for the new Admin → Dashboard
 * tab — everything here is a straight aggregate across every tenant,
 * unlike every other count in the app (dashboard/queries.ts et al.),
 * which is RLS-scoped or `.eq(account_id)`-filtered to one tenant.
 * Reads via the service-role client for the same reason
 * /api/admin/accounts does: RLS would otherwise block a cross-tenant
 * read entirely.
 *
 * All independent counts run in one `Promise.all` — mirrors
 * dashboard/queries.ts's `loadMetrics` shape, just without the
 * per-account filter.
 */
export async function GET() {
  try {
    await requirePlatformAdmin()
    const admin = supabaseAdmin()

    const onlineSince = new Date(Date.now() - OFFLINE_AFTER_MS).toISOString()

    const [
      accountsTotal,
      accountsActive,
      accountsSuspendedManual,
      accountsSuspendedOverdue,
      usersTotal,
      usersOnline,
      connectionsTotal,
      connectionsConnected,
      conversationsTotal,
      conversationsOpen,
      conversationsPending,
      conversationsClosed,
      contactsTotal,
      messagesTotal,
      messagesSent,
      messagesReceived,
      invoicesPaid,
      invoicesOutstanding,
    ] = await Promise.all([
      admin.from('accounts').select('id', { count: 'exact', head: true }),
      admin.from('accounts').select('id', { count: 'exact', head: true }).eq('status', 'active'),
      admin
        .from('accounts')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'suspended')
        .eq('suspended_reason', 'manual'),
      admin
        .from('accounts')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'suspended')
        .eq('suspended_reason', 'overdue'),
      admin.from('profiles').select('id', { count: 'exact', head: true }),
      // Service-role bypasses member_presence's per-account RLS — the
      // only way to count online users platform-wide, not just within
      // one tenant. Same "stale heartbeat = offline" rule as
      // derivePresence() (presence.ts), just evaluated in SQL instead
      // of per-row in JS since we only need the count.
      admin.from('member_presence').select('user_id', { count: 'exact', head: true }).gte('last_seen_at', onlineSince),
      admin.from('whatsapp_config').select('id', { count: 'exact', head: true }),
      admin.from('whatsapp_config').select('id', { count: 'exact', head: true }).eq('status', 'connected'),
      admin.from('conversations').select('id', { count: 'exact', head: true }),
      admin.from('conversations').select('id', { count: 'exact', head: true }).eq('status', 'open'),
      admin.from('conversations').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      admin.from('conversations').select('id', { count: 'exact', head: true }).eq('status', 'closed'),
      admin.from('contacts').select('id', { count: 'exact', head: true }),
      admin.from('messages').select('id', { count: 'exact', head: true }),
      admin.from('messages').select('id', { count: 'exact', head: true }).in('sender_type', ['agent', 'bot']),
      admin.from('messages').select('id', { count: 'exact', head: true }).eq('sender_type', 'customer'),
      admin.from('invoices').select('amount_cents').eq('status', 'paid'),
      admin.from('invoices').select('amount_cents').in('status', ['pending', 'overdue']),
    ])

    const sumCents = (rows: { data: { amount_cents: number }[] | null }) =>
      (rows.data ?? []).reduce((sum, r) => sum + r.amount_cents, 0)

    return NextResponse.json({
      version: packageJson.version,
      accounts: {
        total: accountsTotal.count ?? 0,
        active: accountsActive.count ?? 0,
        suspendedManual: accountsSuspendedManual.count ?? 0,
        suspendedOverdue: accountsSuspendedOverdue.count ?? 0,
      },
      users: {
        total: usersTotal.count ?? 0,
        online: usersOnline.count ?? 0,
      },
      connections: {
        total: connectionsTotal.count ?? 0,
        connected: connectionsConnected.count ?? 0,
      },
      conversations: {
        total: conversationsTotal.count ?? 0,
        open: conversationsOpen.count ?? 0,
        pending: conversationsPending.count ?? 0,
        closed: conversationsClosed.count ?? 0,
      },
      contacts: { total: contactsTotal.count ?? 0 },
      messages: {
        total: messagesTotal.count ?? 0,
        sent: messagesSent.count ?? 0,
        received: messagesReceived.count ?? 0,
      },
      invoices: {
        paidCents: sumCents(invoicesPaid),
        outstandingCents: sumCents(invoicesOutstanding),
      },
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
