'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Clock } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
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
import type { BusinessHoursWeek, DayHours, DayKey } from '@/lib/delivery/business-hours';

const DAY_KEYS: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DEFAULT_HOURS: DayHours = { open: '09:00', close: '22:00' };

const TIMEZONES = [
  'America/Sao_Paulo',
  'America/Manaus',
  'America/Bahia',
  'America/Recife',
  'America/Fortaleza',
  'America/Rio_Branco',
  'America/Noronha',
  'UTC',
];

export function BusinessHoursConfig() {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const t = useTranslations('Settings.businessHours');
  const tDay = useTranslations('Delivery.weekdays');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [timezone, setTimezone] = useState('America/Sao_Paulo');
  const [hours, setHours] = useState<BusinessHoursWeek>({});

  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/delivery/business-hours');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      if (data.configured) {
        setEnabled(Boolean(data.enabled));
        setTimezone(data.timezone ?? 'America/Sao_Paulo');
        setHours((data.hours as BusinessHoursWeek) ?? {});
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

  const toggleDay = (day: DayKey, open: boolean) => {
    setHours((prev) => ({ ...prev, [day]: open ? { ...DEFAULT_HOURS, ...prev[day] } : null }));
  };

  const setDayTime = (day: DayKey, field: 'open' | 'close', value: string) => {
    setHours((prev) => {
      const current = prev[day] ?? DEFAULT_HOURS;
      return { ...prev, [day]: { ...current, [field]: value } };
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/delivery/business-hours', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, timezone, hours }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(t('saveSuccess'));
        await fetchConfig();
      } else {
        toast.error(data.error ?? t('saveFailed'));
      }
    } catch {
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
              <Clock className="h-4 w-4 text-primary" /> {t('schedule')}
            </CardTitle>
            <CardDescription>{t('scheduleDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">{t('enforce')}</p>
                <p className="text-xs text-muted-foreground">{t('enforceDesc')}</p>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} disabled={disabled} />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">{t('timezone')}</label>
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                disabled={disabled}
                className="w-full rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground"
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              {DAY_KEYS.map((day) => {
                const dayHours = hours[day];
                const open = Boolean(dayHours);
                return (
                  <div key={day} className="flex items-center gap-3 rounded-md border border-border p-2.5">
                    <span className="w-20 shrink-0 text-sm text-foreground">{tDay(day)}</span>
                    <Switch checked={open} onCheckedChange={(v) => toggleDay(day, v)} disabled={disabled} />
                    {open ? (
                      <div className="flex items-center gap-2 text-sm">
                        <input
                          type="time"
                          value={dayHours?.open ?? DEFAULT_HOURS.open}
                          onChange={(e) => setDayTime(day, 'open', e.target.value)}
                          disabled={disabled}
                          className="rounded-md border border-border bg-muted px-2 py-1 text-foreground"
                        />
                        <span className="text-muted-foreground">–</span>
                        <input
                          type="time"
                          value={dayHours?.close ?? DEFAULT_HOURS.close}
                          onChange={(e) => setDayTime(day, 'close', e.target.value)}
                          disabled={disabled}
                          className="rounded-md border border-border bg-muted px-2 py-1 text-foreground"
                        />
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">{t('closedAllDay')}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={disabled}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
