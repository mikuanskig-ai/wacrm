'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Loader2, Printer } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';
import { useTranslations } from 'next-intl';

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
    setLoading(true);
    try {
      const res = await fetch('/api/delivery/print-config');
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
    void fetchConfig();
  }, [accountId, fetchConfig]);

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
                <p className="text-xs text-muted-foreground">
                  {lastPolledAt
                    ? t('lastPolled', { time: new Date(lastPolledAt).toLocaleString() })
                    : t('neverPolled')}
                </p>
              </div>
              <Switch checked={enabled} onCheckedChange={handleToggle} disabled={disabled} />
            </div>

            <p className="text-xs text-muted-foreground">
              {t.rich('apiKeyHint', {
                link: (chunks) => (
                  <Link href="/settings?tab=api" className="text-primary underline underline-offset-2">
                    {chunks}
                  </Link>
                ),
              })}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
