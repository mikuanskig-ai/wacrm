import { NextResponse } from 'next/server'
import { execSync } from 'node:child_process'
import { requirePlatformAdmin } from '@/lib/auth/platform-admin'
import { toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

/**
 * POST /api/admin/restart  (platform admin only)
 *
 * Restarts the app's own systemd unit — the "Reiniciar Backend"
 * button on Admin → Dashboard. The unit (`wacrm.service`) runs with no
 * `User=` directive (confirmed on the production host), so it runs as
 * root and this needs no extra sudo/permission setup.
 *
 * Responds success FIRST, then fires the actual restart after a short
 * delay — `systemctl restart` kills this very process, so the delay
 * is what lets the success response actually reach the client instead
 * of the connection just dying mid-request.
 */
export async function POST() {
  try {
    const { userId } = await requirePlatformAdmin()

    const limit = checkRateLimit(`admin-restart:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    console.warn(`[admin/restart] backend restart requested by platform admin ${userId}`)

    setTimeout(() => {
      try {
        execSync('systemctl restart wacrm.service')
      } catch (err) {
        // Never reaches the client either way (the process is gone by
        // the time this could matter) — logged so it's at least
        // diagnosable from journalctl if the unit itself rejects the
        // command for some reason (e.g. run outside systemd/no
        // permission on a future deploy).
        console.error('[admin/restart] systemctl restart failed:', err instanceof Error ? err.message : err)
      }
    }, 300)

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
