'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Store, Copy, Wand2 } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
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
import { isValidSlugFormat, slugify } from '@/lib/delivery/slug';

export function PublicMenuConfig() {
  const { account, accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const t = useTranslations('Settings.publicMenu');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedSlug, setSavedSlug] = useState<string | null>(null);
  const [slugInput, setSlugInput] = useState('');

  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/delivery/public-menu');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      setSavedSlug(data.slug ?? null);
      setSlugInput(data.slug ?? '');
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

  const trimmedSlug = slugInput.trim().toLowerCase();
  const slugIsValid = trimmedSlug.length === 0 || isValidSlugFormat(trimmedSlug);
  const slugChanged = trimmedSlug !== (savedSlug ?? '');

  const publicUrl =
    typeof window !== 'undefined' && savedSlug ? `${window.location.origin}/c/${savedSlug}` : null;

  const handleSuggest = () => {
    if (!account?.name) return;
    setSlugInput(slugify(account.name));
  };

  const handleCopy = async () => {
    if (!publicUrl) return;
    await navigator.clipboard.writeText(publicUrl);
    toast.success(t('linkCopied'));
  };

  const handleSave = async () => {
    if (!trimmedSlug || !slugIsValid) return;
    setSaving(true);
    try {
      const res = await fetch('/api/delivery/public-menu', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: trimmedSlug }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(t('saveSuccess'));
        setSavedSlug(trimmedSlug);
      } else if (data.error === 'slug_taken') {
        toast.error(t('slugTaken'));
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
              <Store className="h-4 w-4 text-primary" /> {t('slugLabel')}
            </CardTitle>
            <CardDescription>{t('slugHint')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {publicUrl && (
              <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 p-3">
                <span className="truncate text-sm text-foreground">{publicUrl}</span>
                <Button size="sm" variant="outline" onClick={handleCopy} className="shrink-0">
                  <Copy className="mr-1.5 h-3.5 w-3.5" /> {t('copyLink')}
                </Button>
              </div>
            )}

            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-sm text-muted-foreground">/c/</span>
                <input
                  type="text"
                  value={slugInput}
                  onChange={(e) => setSlugInput(e.target.value)}
                  placeholder={t('slugPlaceholder')}
                  disabled={disabled}
                  className="w-full rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleSuggest}
                  disabled={disabled || !account?.name}
                  className="shrink-0"
                >
                  <Wand2 className="mr-1.5 h-3.5 w-3.5" /> {t('suggest')}
                </Button>
              </div>
              {!slugIsValid && <p className="text-xs text-destructive">{t('slugInvalid')}</p>}
              {savedSlug && slugChanged && slugIsValid && (
                <p className="text-xs text-amber-500">{t('editWarning')}</p>
              )}
              {!savedSlug && <p className="text-xs text-muted-foreground">{t('notSetYet')}</p>}
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={disabled || !trimmedSlug || !slugIsValid || !slugChanged}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
