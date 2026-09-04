"use client"

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { startOfDay, endOfDay, subDays } from 'date-fns'
import { AlertTriangle, Info, Users, ShoppingBag, Repeat2, Heart } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { hasModule } from '@/lib/accounts/modules'
import { loadDeliveryFunnel } from '@/lib/dashboard/delivery-funnel'
import type { DeliveryFunnelData } from '@/lib/dashboard/types'
import { OrderDateRangeFilter, type OrderDateRange } from '@/components/delivery/order-date-range-filter'
import { Button } from '@/components/ui/button'
import { MetricCard } from './metric-card'
import { SkeletonCard } from './skeleton'
import { EmptyState } from './empty-state'

// "Todo o período" (value === null on the filter) resolves to this —
// treated as "since the account's creation" rather than blocked.
const EPOCH = new Date(0)

// Mirrors the "last30Days" preset in order-date-range-filter.tsx
// (not exported from there — duplicated on purpose, it's two lines).
function defaultRange(): OrderDateRange {
  return { from: startOfDay(subDays(new Date(), 29)), to: endOfDay(new Date()) }
}

function pctLabel(part: number, base: number, suffix: string): string | undefined {
  if (base <= 0) return undefined
  return `${Math.round((part / base) * 100)}% ${suffix}`
}

/**
 * Delivery customer funnel — novos contatos → converteram (1+ pedido)
 * → recorrentes (2+) → fiéis (3+), scoped to the selected date range
 * (recurrence itself is always lifetime — see migration 076's header
 * comment). Renders nothing while the profile is loading or when the
 * delivery module is off — self-contained gate, same as the other
 * delivery-only pages (pedidos/cardapio/operacao), since the
 * dashboard has no shared section-gating infra today.
 */
export function DeliveryFunnelSection() {
  const t = useTranslations('Dashboard.deliveryFunnel')
  const tLoadError = useTranslations('Dashboard.loadError')
  const { account, accountId, profileLoading } = useAuth()
  const moduleEnabled = hasModule(account, 'delivery')

  const [range, setRange] = useState<OrderDateRange | null>(defaultRange())
  const [data, setData] = useState<DeliveryFunnelData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const load = useCallback(() => {
    if (!accountId) return
    setLoading(true)
    setError(false)
    const db = createClient()
    const effective = range ?? { from: EPOCH, to: new Date() }
    void loadDeliveryFunnel(db, accountId, effective)
      .then(setData)
      .catch((err) => {
        console.error('[dashboard] delivery funnel failed:', err)
        setError(true)
      })
      .finally(() => setLoading(false))
  }, [accountId, range])

  useEffect(() => {
    if (profileLoading || !moduleEnabled || !accountId) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kicks off the async load, settled inside load()'s own .finally callback
    load()
  }, [profileLoading, moduleEnabled, accountId, load])

  if (profileLoading || !moduleEnabled) return null

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('description')}</p>
        </div>
        <OrderDateRangeFilter value={range} onChange={setRange} />
      </div>

      {error ? (
        <EmptyState
          icon={AlertTriangle}
          title={tLoadError('title')}
          hint={tLoadError('hint')}
          action={
            <Button size="sm" variant="outline" onClick={load}>
              {tLoadError('retry')}
            </Button>
          }
        />
      ) : loading || !data ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard title={t('newContacts')} value={data.newContacts.toLocaleString()} icon={Users} />
            <MetricCard
              title={t('orderingCustomers')}
              value={data.orderingCustomers.toLocaleString()}
              icon={ShoppingBag}
              subtitle={pctLabel(data.orderingCustomers, data.newContacts, t('ofNewContacts'))}
            />
            <MetricCard
              title={t('returningCustomers')}
              value={data.returningCustomers.toLocaleString()}
              icon={Repeat2}
              subtitle={pctLabel(data.returningCustomers, data.orderingCustomers, t('ofOrderingCustomers'))}
            />
            <MetricCard
              title={t('loyalCustomers')}
              value={data.loyalCustomers.toLocaleString()}
              icon={Heart}
              subtitle={pctLabel(data.loyalCustomers, data.orderingCustomers, t('ofOrderingCustomers'))}
            />
          </div>
          {data.unattributedOrders > 0 && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Info className="h-3.5 w-3.5" aria-hidden />
              {t('unattributedOrders', { count: data.unattributedOrders })}
            </p>
          )}
        </>
      )}
    </div>
  )
}
