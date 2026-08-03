'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import { Check, Plus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import type { Tag as TagRecord } from '@/types';

const STEPS = ['setup', 'audience', 'review'] as const;
type StepKey = (typeof STEPS)[number];

const MAX_VARIANTS = 3;

export default function NewCampaignPage() {
  const router = useRouter();
  const t = useTranslations('Broadcasts.new');

  const [step, setStep] = useState<StepKey>('setup');
  const [launching, setLaunching] = useState(false);

  // --- Setup ---
  const [name, setName] = useState('');
  const [variants, setVariants] = useState<string[]>(['']);
  const [mediaUrl, setMediaUrl] = useState('');
  const [delaySeconds, setDelaySeconds] = useState(30);
  const [sendMode, setSendMode] = useState<'now' | 'later'>('now');
  const [scheduledAt, setScheduledAt] = useState('');

  // --- Audience ---
  const [segmentType, setSegmentType] = useState<'all' | 'tags'>('all');
  const [tags, setTags] = useState<TagRecord[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [count, setCount] = useState<number | null>(null);
  const [countLoading, setCountLoading] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    void supabase
      .from('tags')
      .select('*')
      .order('name')
      .then(({ data }) => setTags((data as TagRecord[] | null) ?? []));
  }, []);

  useEffect(() => {
    if (step !== 'audience') return;
    let cancelled = false;
    const supabase = createClient();
    void (async () => {
      setCountLoading(true);
      let query = supabase
        .from('contacts')
        .select('id', { count: 'exact', head: true })
        .not('phone', 'is', null);
      if (segmentType === 'tags') {
        if (selectedTagIds.length === 0) {
          if (!cancelled) {
            setCount(0);
            setCountLoading(false);
          }
          return;
        }
        const { data: taggedRows } = await supabase
          .from('contact_tags')
          .select('contact_id')
          .in('tag_id', selectedTagIds);
        const ids = Array.from(new Set((taggedRows ?? []).map((r) => r.contact_id)));
        if (ids.length === 0) {
          if (!cancelled) {
            setCount(0);
            setCountLoading(false);
          }
          return;
        }
        query = query.in('id', ids);
      }
      const { count: c } = await query;
      if (!cancelled) {
        setCount(c ?? 0);
        setCountLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, segmentType, selectedTagIds]);

  function updateVariant(i: number, value: string) {
    setVariants((v) => v.map((x, idx) => (idx === i ? value : x)));
  }
  function addVariant() {
    if (variants.length >= MAX_VARIANTS) return;
    setVariants((v) => [...v, '']);
  }
  function removeVariant(i: number) {
    setVariants((v) => v.filter((_, idx) => idx !== i));
  }
  function toggleTag(id: string) {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }

  function goToAudience() {
    if (!variants.some((v) => v.trim())) {
      toast.error(t('toasts.missingVariant'));
      return;
    }
    setStep('audience');
  }

  function goToReview() {
    if (segmentType === 'tags' && selectedTagIds.length === 0) {
      toast.error(t('toasts.missingTags'));
      return;
    }
    setStep('review');
  }

  async function launch() {
    setLaunching(true);
    try {
      const res = await fetch('/api/whatsapp/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim() || undefined,
          message_variants: variants.map((v) => v.trim()).filter(Boolean),
          media_url: mediaUrl.trim() || undefined,
          delay_seconds: delaySeconds,
          scheduled_at: sendMode === 'later' && scheduledAt ? new Date(scheduledAt).toISOString() : null,
          segment:
            segmentType === 'all'
              ? { type: 'all' }
              : { type: 'tags', tag_ids: selectedTagIds },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || t('toasts.failed'));
        setLaunching(false);
        return;
      }
      toast.success(t('toasts.created'));
      router.push(`/broadcasts/${data.broadcast_id}`);
    } catch (err) {
      console.error('Campaign launch failed:', err);
      toast.error(t('toasts.failed'));
      setLaunching(false);
    }
  }

  const stepIndex = STEPS.indexOf(step);

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <div className="flex items-center justify-between">
        {STEPS.map((s, index) => {
          const isActive = index === stepIndex;
          const isCompleted = index < stepIndex;
          return (
            <div key={s} className="flex flex-1 items-center">
              <div className="flex items-center gap-2">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium ${
                    isCompleted
                      ? 'bg-primary text-primary-foreground'
                      : isActive
                        ? 'border-2 border-primary bg-primary/10 text-primary'
                        : 'border border-border bg-muted text-muted-foreground'
                  }`}
                >
                  {isCompleted ? <Check className="h-4 w-4" /> : index + 1}
                </div>
                <span
                  className={`hidden text-sm font-medium sm:block ${
                    isActive ? 'text-foreground' : isCompleted ? 'text-primary' : 'text-muted-foreground'
                  }`}
                >
                  {t(`steps.${s}`)}
                </span>
              </div>
              {index < STEPS.length - 1 && (
                <div className={`mx-3 h-px flex-1 ${index < stepIndex ? 'bg-primary' : 'bg-muted'}`} />
              )}
            </div>
          );
        })}
      </div>

      {step === 'setup' && (
        <Card>
          <CardContent className="space-y-5 pt-6">
            <div className="space-y-2">
              <Label>{t('setup.nameLabel')}</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('setup.namePlaceholder')} />
            </div>

            <div className="space-y-2">
              <Label>{t('setup.variantsLabel')}</Label>
              <p className="text-xs text-muted-foreground">{t('setup.variantsHint')}</p>
              {variants.map((v, i) => (
                <div key={i} className="flex gap-2">
                  <Textarea
                    value={v}
                    onChange={(e) => updateVariant(i, e.target.value)}
                    placeholder={t('setup.variantPlaceholder', { n: i + 1 })}
                    className="min-h-20"
                  />
                  {variants.length > 1 && (
                    <Button type="button" variant="outline" size="icon" onClick={() => removeVariant(i)}>
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))}
              {variants.length < MAX_VARIANTS && (
                <Button type="button" variant="outline" size="sm" onClick={addVariant}>
                  <Plus className="h-4 w-4" />
                  {t('setup.addVariant')}
                </Button>
              )}
              <p className="text-xs text-muted-foreground">{t('setup.variablesHint')}</p>
            </div>

            <div className="space-y-2">
              <Label>{t('setup.mediaLabel')}</Label>
              <Input value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} placeholder={t('setup.mediaPlaceholder')} />
            </div>

            <div className="space-y-2">
              <Label>{t('setup.delayLabel')}</Label>
              <Input
                type="number"
                min={0}
                value={delaySeconds}
                onChange={(e) => setDelaySeconds(Math.max(0, Number(e.target.value) || 0))}
              />
              <p className="text-xs text-muted-foreground">{t('setup.delayHint')}</p>
            </div>

            <div className="space-y-2">
              <Label>{t('setup.scheduleLabel')}</Label>
              <RadioGroup value={sendMode} onValueChange={(v) => setSendMode(v as 'now' | 'later')}>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="now" id="send-now" />
                  <Label htmlFor="send-now" className="font-normal">{t('setup.sendNow')}</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="later" id="send-later" />
                  <Label htmlFor="send-later" className="font-normal">{t('setup.sendLater')}</Label>
                </div>
              </RadioGroup>
              {sendMode === 'later' && (
                <div className="space-y-1 pt-1">
                  <Label className="text-xs text-muted-foreground">{t('setup.scheduledAtLabel')}</Label>
                  <Input
                    type="datetime-local"
                    value={scheduledAt}
                    onChange={(e) => setScheduledAt(e.target.value)}
                  />
                </div>
              )}
            </div>

            <div className="flex justify-end">
              <Button onClick={goToAudience}>{t('setup.next')}</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'audience' && (
        <Card>
          <CardHeader>
            <CardTitle>{t('audience.title')}</CardTitle>
            <p className="text-sm text-muted-foreground">{t('audience.subtitle')}</p>
          </CardHeader>
          <CardContent className="space-y-4">
            <RadioGroup value={segmentType} onValueChange={(v) => setSegmentType(v as 'all' | 'tags')}>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="all" id="seg-all" />
                <Label htmlFor="seg-all" className="font-normal">{t('audience.allContacts')}</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="tags" id="seg-tags" />
                <Label htmlFor="seg-tags" className="font-normal">{t('audience.byTags')}</Label>
              </div>
            </RadioGroup>

            {segmentType === 'tags' && (
              <div className="space-y-2 rounded-md border border-border p-3">
                {tags.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('audience.tagsPlaceholder')}</p>
                ) : (
                  tags.map((tag) => (
                    <div key={tag.id} className="flex items-center gap-2">
                      <Checkbox
                        id={`tag-${tag.id}`}
                        checked={selectedTagIds.includes(tag.id)}
                        onCheckedChange={() => toggleTag(tag.id)}
                      />
                      <Label htmlFor={`tag-${tag.id}`} className="font-normal">{tag.name}</Label>
                    </div>
                  ))
                )}
              </div>
            )}

            <p className="text-sm text-muted-foreground">
              {countLoading
                ? t('audience.countLoading')
                : count === 0
                  ? t('audience.countZero')
                  : t('audience.count', { count: count ?? 0 })}
            </p>

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep('setup')}>{t('audience.back')}</Button>
              <Button onClick={goToReview}>{t('audience.next')}</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'review' && (
        <Card>
          <CardHeader>
            <CardTitle>{t('review.title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t('review.name')}</dt>
                <dd className="text-foreground">{name || '—'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t('review.messages')}</dt>
                <dd className="text-right text-foreground">{variants.filter((v) => v.trim()).length}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t('review.media')}</dt>
                <dd className="text-foreground">{mediaUrl.trim() || t('review.mediaNone')}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t('setup.delayLabel')}</dt>
                <dd className="text-foreground">{t('review.delay', { seconds: delaySeconds })}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t('review.schedule')}</dt>
                <dd className="text-foreground">
                  {sendMode === 'now' || !scheduledAt
                    ? t('review.scheduleNow')
                    : new Date(scheduledAt).toLocaleString()}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t('review.audience')}</dt>
                <dd className="text-foreground">
                  {segmentType === 'all'
                    ? t('review.audienceAll')
                    : t('review.audienceTags', { count: selectedTagIds.length })}
                </dd>
              </div>
            </dl>

            <Alert>
              <AlertDescription>{t('review.banRisk')}</AlertDescription>
            </Alert>

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep('audience')} disabled={launching}>
                {t('review.back')}
              </Button>
              <Button onClick={launch} disabled={launching}>
                {launching ? t('review.launching') : t('review.launch')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
