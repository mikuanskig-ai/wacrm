"use client"

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { formatCurrency } from '@/lib/currency'
import {
  AlertTriangle,
  MessageSquare,
  UserPlus,
  DollarSign,
  Send,
} from 'lucide-react'
import { Button } from '@/components/ui/button'

import {
  loadActivity,
  loadConversationsSeries,
  loadMetrics,
  loadPipelineDonut,
  loadResponseTime,
} from '@/lib/dashboard/queries'
import type {
  ActivityItem,
  ConversationsSeriesPoint,
  MetricsBundle,
  PipelineDonutData,
  ResponseTimeSummary,
} from '@/lib/dashboard/types'

import { MetricCard } from '@/components/dashboard/metric-card'
import { EmptyState } from '@/components/dashboard/empty-state'
import { SkeletonCard } from '@/components/dashboard/skeleton'
import { QuickActions } from '@/components/dashboard/quick-actions'
import { DeliveryFunnelSection } from '@/components/dashboard/delivery-funnel-section'
import { OnboardingChecklist } from '@/components/dashboard/onboarding-checklist'
import { ConversationsChart } from '@/components/dashboard/conversations-chart'
import { PipelineDonut } from '@/components/dashboard/pipeline-donut'
import { ResponseTimeChart } from '@/components/dashboard/response-time-chart'
import { ActivityFeed } from '@/components/dashboard/activity-feed'

import { useTranslations } from 'next-intl'

type RangeDays = 7 | 30 | 90

export default function DashboardPage() {
  const t = useTranslations('Dashboard.page')
  const tLoadError = useTranslations('Dashboard.loadError')
  const { defaultCurrency } = useAuth()
  const [metrics, setMetrics] = useState<MetricsBundle | null>(null)
  const [metricsLoading, setMetricsLoading] = useState(true)
  const [metricsError, setMetricsError] = useState(false)

  const [range, setRange] = useState<RangeDays>(30)
  // Keep a cache per range so switching tabs doesn't re-fetch what we
  // already have. Ranges the user hasn't opened yet stay null and
  // trigger a fetch on first view.
  const [series, setSeries] = useState<Record<RangeDays, ConversationsSeriesPoint[] | null>>({
    7: null,
    30: null,
    90: null,
  })
  const [seriesLoading, setSeriesLoading] = useState(true)
  const [seriesError, setSeriesError] = useState(false)

  const [pipeline, setPipeline] = useState<PipelineDonutData | null>(null)
  const [pipelineLoading, setPipelineLoading] = useState(true)
  const [pipelineError, setPipelineError] = useState(false)

  const [responseTime, setResponseTime] = useState<ResponseTimeSummary | null>(null)
  const [responseTimeLoading, setResponseTimeLoading] = useState(true)
  const [responseTimeError, setResponseTimeError] = useState(false)

  const [activity, setActivity] = useState<ActivityItem[] | null>(null)
  const [activityLoading, setActivityLoading] = useState(true)
  const [activityError, setActivityError] = useState(false)

  // Each section gets its own fetch function so a retry button can
  // re-run just the widget that failed, instead of reloading
  // everything else that already succeeded.
  const loadMetricsSection = useCallback(() => {
    setMetricsLoading(true)
    setMetricsError(false)
    const db = createClient()
    void loadMetrics(db)
      .then((m) => setMetrics(m))
      .catch((err) => {
        console.error('[dashboard] metrics failed:', err)
        setMetricsError(true)
      })
      .finally(() => setMetricsLoading(false))
  }, [])

  const loadSeriesSection = useCallback((r: RangeDays) => {
    setSeriesLoading(true)
    setSeriesError(false)
    const db = createClient()
    void loadConversationsSeries(db, r)
      .then((s) => setSeries((prev) => ({ ...prev, [r]: s })))
      .catch((err) => {
        console.error('[dashboard] series failed:', err)
        setSeriesError(true)
      })
      .finally(() => setSeriesLoading(false))
  }, [])

  const loadPipelineSection = useCallback(() => {
    setPipelineLoading(true)
    setPipelineError(false)
    const db = createClient()
    void loadPipelineDonut(db)
      .then((p) => setPipeline(p))
      .catch((err) => {
        console.error('[dashboard] pipeline failed:', err)
        setPipelineError(true)
      })
      .finally(() => setPipelineLoading(false))
  }, [])

  const loadResponseTimeSection = useCallback(() => {
    setResponseTimeLoading(true)
    setResponseTimeError(false)
    const db = createClient()
    void loadResponseTime(db)
      .then((r) => setResponseTime(r))
      .catch((err) => {
        console.error('[dashboard] response time failed:', err)
        setResponseTimeError(true)
      })
      .finally(() => setResponseTimeLoading(false))
  }, [])

  const loadActivitySection = useCallback(() => {
    setActivityLoading(true)
    setActivityError(false)
    const db = createClient()
    // Fetch up to 50 so the biggest page-size option in the feed
    // (50 rows) is already in memory — switching sizes then becomes
    // a pure client-side slice with no extra round trip.
    void loadActivity(db, 50)
      .then((a) => setActivity(a))
      .catch((err) => {
        console.error('[dashboard] activity failed:', err)
        setActivityError(true)
      })
      .finally(() => setActivityLoading(false))
  }, [])

  useEffect(() => {
    loadMetricsSection()
    loadSeriesSection(30)
    loadPipelineSection()
    loadResponseTimeSection()
    loadActivitySection()
    // Only runs once on mount — each section's own retry/range-change
    // handler covers everything after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Range switch handler — kept in an event callback (not an effect)
  // so the setState calls stay out of the react-hooks/set-state-in-effect
  // rule's way. The cached bucket check means switching back to a
  // previously-viewed range is instant and doesn't re-fetch.
  const handleRangeChange = useCallback(
    (r: RangeDays) => {
      setRange(r)
      if (series[r] !== null) return
      loadSeriesSection(r)
    },
    [series, loadSeriesSection],
  )

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('description')}
        </p>
      </div>

      {/* First-login checklist — renders nothing once dismissed/complete
          or for non-admin roles (UX audit Parte 4). */}
      <OnboardingChecklist />

      {/* Metric cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {metricsError ? (
          <div className="sm:col-span-2 lg:col-span-4">
            <EmptyState
              icon={AlertTriangle}
              title={tLoadError('title')}
              hint={tLoadError('hint')}
              action={
                <Button size="sm" variant="outline" onClick={loadMetricsSection}>
                  {tLoadError('retry')}
                </Button>
              }
            />
          </div>
        ) : metricsLoading || !metrics ? (
          Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <MetricCard
              title={t('activeConversations')}
              value={metrics.activeConversations.current.toLocaleString()}
              icon={MessageSquare}
              delta={{
                sign: metrics.activeConversations.previous,
                label: deltaLabel(
                  metrics.activeConversations.previous, 
                  t('newTodayVsYesterday'), 
                  t('noChange', { suffix: t('newTodayVsYesterday') })
                ),
              }}
            />
            <MetricCard
              title={t('newContactsToday')}
              value={metrics.newContactsToday.current.toLocaleString()}
              icon={UserPlus}
              delta={{
                sign:
                  metrics.newContactsToday.current - metrics.newContactsToday.previous,
                label: deltaLabel(
                  metrics.newContactsToday.current - metrics.newContactsToday.previous,
                  t('vsYesterday'),
                  t('noChange', { suffix: t('vsYesterday') })
                ),
              }}
            />
            <MetricCard
              title={t('openDealsValue')}
              value={formatCurrency(metrics.openDealsValue, defaultCurrency)}
              icon={DollarSign}
              subtitle={t('openDeals', { count: metrics.openDealsCount })}
            />
            <MetricCard
              title={t('messagesSentToday')}
              value={metrics.messagesSentToday.current.toLocaleString()}
              icon={Send}
              delta={{
                sign:
                  metrics.messagesSentToday.current - metrics.messagesSentToday.previous,
                label: deltaLabel(
                  metrics.messagesSentToday.current - metrics.messagesSentToday.previous,
                  t('vsYesterday'),
                  t('noChange', { suffix: t('vsYesterday') })
                ),
              }}
            />
          </>
        )}
      </div>

      {/* Quick actions */}
      <QuickActions />

      {/* Delivery: funil de conversão/recorrência de clientes. Renderiza
          null internamente se o módulo delivery estiver desligado ou o
          perfil ainda estiver carregando — nenhuma condicional aqui. */}
      <DeliveryFunnelSection />

      {/* Charts row */}
      {/* items-stretch (the grid default) stretches the two columns to
          match the tallest sibling; adding h-full on each wrapper and
          on the inner panels makes both cards actually fill that
          stretched height so their rounded borders line up. Without
          this, the pipeline card rendered at its natural (shorter)
          height while the line chart drove the row height. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="h-full lg:col-span-3">
          <ConversationsChart
            series={series}
            loading={seriesLoading}
            error={seriesError}
            onRetry={() => loadSeriesSection(range)}
            range={range}
            onRangeChange={handleRangeChange}
          />
        </div>
        <div className="h-full lg:col-span-2">
          <PipelineDonut
            data={pipeline}
            loading={pipelineLoading}
            error={pipelineError}
            onRetry={loadPipelineSection}
            currency={defaultCurrency}
          />
        </div>
      </div>

      {/* Response time */}
      <ResponseTimeChart
        data={responseTime}
        loading={responseTimeLoading}
        error={responseTimeError}
        onRetry={loadResponseTimeSection}
      />

      {/* Activity feed */}
      <ActivityFeed
        items={activity}
        loading={activityLoading}
        error={activityError}
        onRetry={loadActivitySection}
      />
    </div>
  )
}

// ------------------------------------------------------------

function deltaLabel(delta: number, suffix: string, noChangeLabel: string): string {
  if (delta === 0) return noChangeLabel
  const sign = delta > 0 ? '+' : ''
  return `${sign}${delta.toLocaleString()} ${suffix}`
}
