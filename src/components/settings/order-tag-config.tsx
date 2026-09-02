'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Tag as TagIcon } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsPanelHead } from './settings-panel-head';
import { useTranslations } from 'next-intl';

interface TagOption {
  id: string;
  name: string;
  color: string;
}

const NONE_VALUE = '__none__';

/**
 * Which tag (if any) gets applied to a contact automatically when
 * they place a delivery order — deterministic (finalizeDeliveryOrder,
 * create-order.ts), applies regardless of order source (AI chat,
 * manual, Flow builder, public checkout). Requested 2026-09-01.
 */
export function OrderTagConfig() {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const t = useTranslations('Settings.orderTag');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tagId, setTagId] = useState<string | null>(null);
  const [tags, setTags] = useState<TagOption[]>([]);

  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/delivery/order-tag-config', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      setTagId(data.tagId ?? null);
      setTags(data.tags ?? []);
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

  const handleChange = async (value: string | null) => {
    const next = value === NONE_VALUE || !value ? null : value;
    const previous = tagId;
    setTagId(next);
    setSaving(true);
    try {
      const res = await fetch('/api/delivery/order-tag-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag_id: next }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(t('saveSuccess'));
      } else {
        setTagId(previous);
        toast.error(data.error ?? t('saveFailed'));
      }
    } catch {
      setTagId(previous);
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

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <TagIcon className="h-4 w-4 text-primary" /> {t('title')}
          </CardTitle>
          <CardDescription>{t('fieldDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {tags.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noTags')}</p>
          ) : (
            <Select
              value={tagId ?? NONE_VALUE}
              onValueChange={handleChange}
              disabled={disabled}
            >
              <SelectTrigger className="w-full sm:w-72">
                <SelectValue placeholder={t('placeholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_VALUE}>{t('none')}</SelectItem>
                {tags.map((tag) => (
                  <SelectItem key={tag.id} value={tag.id}>
                    <span className="flex items-center gap-2">
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: tag.color }}
                      />
                      {tag.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
