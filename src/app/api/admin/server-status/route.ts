import { NextResponse } from 'next/server'
import os from 'node:os'
import { execSync } from 'node:child_process'
import { requirePlatformAdmin } from '@/lib/auth/platform-admin'
import { toErrorResponse } from '@/lib/auth/account'
import { listSessions } from '@/lib/whatsapp/wuzapi-api'

/**
 * GET /api/admin/server-status  (platform admin only)
 *
 * Live server/process health for the Admin → Dashboard tab — new
 * territory for this codebase (no prior `os`/`child_process` usage
 * anywhere). Every section degrades independently rather than failing
 * the whole route: a wuzapi outage or a `df` that doesn't exist on
 * some future host must not take down the OS/CPU/memory numbers next
 * to it.
 */

/** `os.cpus()` gives cumulative tick counts since boot, not a live
 *  percentage — the standard way to get a usage % is two snapshots a
 *  short interval apart and diff them. ~100ms is enough to be
 *  representative without meaningfully slowing this route down. */
async function getCpuUsagePercent(): Promise<number> {
  const start = os.cpus()
  await new Promise((resolve) => setTimeout(resolve, 100))
  const end = os.cpus()

  let idleDelta = 0
  let totalDelta = 0
  for (let i = 0; i < start.length; i++) {
    const s = start[i]!.times
    const e = end[i]!.times
    const idle = e.idle - s.idle
    const total = e.user - s.user + (e.nice - s.nice) + (e.sys - s.sys) + idle + (e.irq - s.irq)
    idleDelta += idle
    totalDelta += total
  }
  if (totalDelta <= 0) return 0
  return Math.round((1 - idleDelta / totalDelta) * 1000) / 10
}

interface DiskInfo {
  totalBytes: number
  freeBytes: number
  usedPercent: number
}

/** Linux-only (`df`) — this is the app's actual deployment target, not
 *  attempting cross-platform support. Returns null (never throws) when
 *  `df` isn't available or its output doesn't parse, so a missing
 *  binary degrades this one card instead of the whole route. */
function getDiskInfo(): DiskInfo | null {
  try {
    // -B1 = byte-exact sizes (not human-rounded), -P = POSIX single-line
    // output so column parsing doesn't depend on terminal width.
    const out = execSync('df -B1 -P /', { encoding: 'utf8', timeout: 2000 })
    const line = out.trim().split('\n')[1]
    if (!line) return null
    const parts = line.trim().split(/\s+/)
    const totalBytes = Number(parts[1])
    const usedBytes = Number(parts[2])
    const freeBytes = Number(parts[3])
    if (!Number.isFinite(totalBytes) || !Number.isFinite(freeBytes) || totalBytes <= 0) return null
    return {
      totalBytes,
      freeBytes,
      usedPercent: Math.round((usedBytes / totalBytes) * 1000) / 10,
    }
  } catch (err) {
    console.error('[admin/server-status] df failed:', err instanceof Error ? err.message : err)
    return null
  }
}

interface WuzapiStatus {
  reachable: boolean
  totalSessions: number
  connectedSessions: number
}

/** Best-effort — the shared wuzapi instance being down/misconfigured
 *  must not break the rest of the dashboard. `WUZAPI_SERVER_URL`/
 *  `WUZAPI_ADMIN_TOKEN` are the same platform-level env vars
 *  provisionUser() already uses to create a new tenant session. */
async function getWuzapiStatus(): Promise<WuzapiStatus | null> {
  const baseUrl = process.env.WUZAPI_SERVER_URL
  const adminToken = process.env.WUZAPI_ADMIN_TOKEN
  if (!baseUrl || !adminToken) return null
  try {
    const sessions = await listSessions({ baseUrl, adminToken })
    return {
      reachable: true,
      totalSessions: sessions.length,
      connectedSessions: sessions.filter((s) => s.connected).length,
    }
  } catch (err) {
    console.error('[admin/server-status] wuzapi listSessions failed:', err instanceof Error ? err.message : err)
    return { reachable: false, totalSessions: 0, connectedSessions: 0 }
  }
}

export async function GET() {
  try {
    await requirePlatformAdmin()

    const [cpuUsagePercent, wuzapi] = await Promise.all([getCpuUsagePercent(), getWuzapiStatus()])
    const totalMem = os.totalmem()
    const freeMem = os.freemem()

    return NextResponse.json({
      general: {
        hostname: os.hostname(),
        platform: os.platform(),
        cpuModel: os.cpus()[0]?.model ?? null,
        externalIp: null, // resolved client-unavailable; left null rather than an outbound lookup on every dashboard load
      },
      cpu: {
        count: os.cpus().length,
        usagePercent: cpuUsagePercent,
      },
      memory: {
        totalBytes: totalMem,
        freeBytes: freeMem,
        usedPercent: Math.round(((totalMem - freeMem) / totalMem) * 1000) / 10,
      },
      uptimeSeconds: os.uptime(),
      disk: getDiskInfo(),
      wuzapi,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
