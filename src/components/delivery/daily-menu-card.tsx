'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { BookOpen, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import type { DailyMenu, DayKey } from '@/lib/delivery/business-hours';
import { useTranslations } from 'next-intl';

const DAY_KEYS: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/**
 * Self-contained, same shape as AiKnowledgeCard (ai-knowledge.tsx) —
 * fetches and saves its own state rather than plugging into the big
 * AI Settings form. Lives on the Cardápio page (not Configuração de
 * IA) because that's where "what's on the menu" belongs now that
 * Cardápio is its own sidebar section — see the plan's reasoning.
 * Saves through POST /api/ai/config/daily-menu, a narrow sibling of
 * /api/ai/config that only ever touches this one column (that route's
 * own doc comment explains why it isn't folded into the shared one).
 */
export function DailyMenuCard({
  accountId,
  canEdit,
}: {
  accountId: string | null;
  canEdit: boolean;
}) {
  const t = useTranslations('Delivery.dailyMenu');
  const tDay = useTranslations('Delivery.weekdays');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // null = AI not configured yet for this account (no ai_configs row) —
  // distinct from {} (configured, nothing filled in for any day).
  const [configured, setConfigured] = useState(true);
  const [menu, setMenu] = useState<DailyMenu>({});
  const loadedAccountIdRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/config');
      const data = await res.json();
      if (res.ok) {
        setConfigured(Boolean(data.configured));
        setMenu((data.daily_menu as DailyMenu) ?? {});
      } else {
        toast.error(data.error ?? t('loadFailed'));
      }
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void load();
  }, [accountId, load]);

  const setDayText = (day: DayKey, value: string) => {
    setMenu((prev) => ({ ...prev, [day]: value }));
  };

  const save = async () => {
    setSaving(true);
    try {
      // Empty textarea → null ("nothing special today"), not an empty
      // string — keeps the stored shape consistent with what a fresh
      // account has (missing key / null), and avoids the prompt
      // injecting a blank line for a day nobody actually filled in.
      const normalized: DailyMenu = {};
      for (const day of DAY_KEYS) {
        const value = menu[day];
        normalized[day] = value && value.trim() ? value.trim() : null;
      }
      const res = await fetch('/api/ai/config/daily-menu', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ daily_menu: normalized }),
      });
      const data = await res.json();
      if (res.ok) {
        setMenu(normalized);
        toast.success(t('saveSuccess'));
      } else {
        toast.error(data.error ?? t('saveFailed'));
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BookOpen className="h-4 w-4 text-primary" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center py-4 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
          </div>
        ) : !configured ? (
          <p className="text-sm text-muted-foreground">
            {t.rich('needsAiSetup', {
              link: (chunks) => (
                <Link href="/agents" className="text-primary underline">
                  {chunks}
                </Link>
              ),
            })}
          </p>
        ) : (
          <>
            <div className="space-y-2">
              {DAY_KEYS.map((day) => (
                <div key={day} className="space-y-1">
                  <label className="text-sm font-medium text-foreground">{tDay(day)}</label>
                  <Textarea
                    value={menu[day] ?? ''}
                    onChange={(e) => setDayText(day, e.target.value)}
                    placeholder={t('placeholder')}
                    rows={2}
                    disabled={!canEdit || saving}
                    maxLength={800}
                  />
                </div>
              ))}
            </div>
            {canEdit && (
              <div className="flex justify-end">
                <Button onClick={save} disabled={saving}>
                  {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {t('save')}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
