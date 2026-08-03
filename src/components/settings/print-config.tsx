'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { CheckCircle2, Download, KeyRound, Loader2, Printer, RadioTower } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

// The agent polls every 5s (print-agent/README.md). Twice that window
// is "still probably online, just between polls" without flickering
// the status between requests; past it, treat it as disconnected.
const FRESH_WINDOW_MS = 10_000;
// Re-check while this panel is open so a shop owner watching the
// pairing steps actually sees it flip to "connected" live, instead of
// only finding out on the next page load.
const POLL_INTERVAL_MS = 5_000;

export function isFresh(lastPolledAt: string | null): boolean {
  if (!lastPolledAt) return false;
  return Date.now() - new Date(lastPolledAt).getTime() < FRESH_WINDOW_MS;
}

export function PrintConfig() {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const t = useTranslations('Settings.printing');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [lastPolledAt, setLastPolledAt] = useState<string | null>(null);

  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/delivery/print-config', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      if (data.configured) {
        setEnabled(Boolean(data.enabled));
        setLastPolledAt(data.last_polled_at ?? null);
      }
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    setLoading(true);
    void fetchConfig();
  }, [accountId, fetchConfig]);

  // Silent background poll (no loading spinner, no error toast — this
  // is a "has the agent checked in yet" heartbeat, not a user action)
  // so the pairing step below can confirm a connection live.
  useEffect(() => {
    if (!accountId) return;
    const id = setInterval(() => {
      fetch('/api/delivery/print-config', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data?.configured) setLastPolledAt(data.last_polled_at ?? null);
        })
        .catch(() => {});
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [accountId]);

  const handleToggle = async (next: boolean) => {
    setEnabled(next);
    setSaving(true);
    try {
      const res = await fetch('/api/delivery/print-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(t('saveSuccess'));
      } else {
        setEnabled(!next);
        toast.error(data.error ?? t('saveFailed'));
      }
    } catch {
      setEnabled(!next);
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (loading || profileLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
      </div>
    );
  }

  const disabled = !canEdit || saving;
  const connected = isFresh(lastPolledAt);

  return (
    <div>
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {!canEdit && (
        <p className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t('adminOnlyConfig')}
        </p>
      )}

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Printer className="h-4 w-4 text-primary" /> {t('title')}
            </CardTitle>
            <CardDescription>{t('enableDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">{t('enable')}</p>
                <p
                  className={cn(
                    'mt-0.5 flex items-center gap-1.5 text-xs',
                    connected ? 'text-emerald-500' : 'text-muted-foreground',
                  )}
                >
                  <span
                    className={cn(
                      'size-1.5 rounded-full',
                      connected ? 'bg-emerald-500' : 'bg-muted-foreground/50',
                    )}
                  />
                  {connected
                    ? t('agentConnected')
                    : lastPolledAt
                      ? t('lastPolled', { time: new Date(lastPolledAt).toLocaleString() })
                      : t('neverPolled')}
                </p>
              </div>
              <Switch checked={enabled} onCheckedChange={handleToggle} disabled={disabled} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Download className="h-4 w-4 text-primary" /> {t('downloadTitle')}
            </CardTitle>
            <CardDescription>{t('downloadDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="space-y-4">
              <PairingStep
                number={1}
                icon={KeyRound}
                title={t('step1Title')}
                description={t('step1Desc')}
                done={false}
              >
                <Button
                  render={<Link href="/settings?tab=api" />}
                  variant="outline"
                  size="sm"
                >
                  {t('step1Cta')}
                </Button>
              </PairingStep>

              <PairingStep
                number={2}
                icon={Download}
                title={t('step2Title')}
                description={t('step2Desc')}
                done={false}
              >
                <Button
                  render={<a href="/downloads/zontalk-print-agent.exe" download />}
                  size="sm"
                >
                  <Download className="h-4 w-4" />
                  {t('downloadButton')}
                </Button>
              </PairingStep>

              <PairingStep
                number={3}
                icon={RadioTower}
                title={t('step3Title')}
                description={connected ? t('step3DescConnected') : t('step3Desc')}
                done={connected}
              >
                {!connected && (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" />
                    {t('waitingForAgent')}
                  </p>
                )}
              </PairingStep>
            </ol>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function PairingStep({
  number,
  icon: Icon,
  title,
  description,
  done,
  children,
}: {
  number: number;
  icon: typeof KeyRound;
  title: string;
  description: string;
  done: boolean;
  children?: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
          done
            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
            : 'border-border bg-muted text-muted-foreground',
        )}
      >
        {done ? <CheckCircle2 className="size-4" /> : number}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5 pb-1">
        <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <Icon className="size-3.5 text-muted-foreground" />
          {title}
        </p>
        <p className="text-xs text-muted-foreground">{description}</p>
        {children}
      </div>
    </li>
  );
}
