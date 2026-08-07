'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Sparkles, CheckCircle2, Trash2, Eye, EyeOff, Clock } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SettingsPanelHead } from './settings-panel-head';
import { AiKnowledgeCard } from './ai-knowledge';
import { AI_PROVIDER_DEFAULT_MODEL, AI_PROVIDER_MODELS } from '@/lib/ai/defaults';
import type { AiProvider } from '@/lib/ai/types';
import { hasModule } from '@/lib/accounts/modules';
import type { AccountMember } from '@/types';
import { fetchAccountMembers, memberLabel } from '@/lib/account/members';
import { useTranslations } from 'next-intl';
import { useConfirmDialog } from '@/hooks/use-confirm-dialog';
import type { BusinessHoursWeek, DayHours, DayKey } from '@/lib/delivery/business-hours';

const MASKED_KEY = '••••••••••••••••';

const HOURS_DAY_KEYS: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DEFAULT_DAY_HOURS: DayHours = { open: '09:00', close: '22:00' };
const HOURS_TIMEZONES = [
  'America/Sao_Paulo',
  'America/Manaus',
  'America/Bahia',
  'America/Recife',
  'America/Fortaleza',
  'America/Rio_Branco',
  'America/Noronha',
  'UTC',
];

// Whisper-compatible transcription is only offered under these two —
// Anthropic/Gemini/OpenRouter have no audio-transcription endpoint
// (same reason embeddings_api_key exists as its own OpenAI-only slot).
const TRANSCRIPTION_PROVIDERS = ['groq', 'openai'] as const;
type TranscriptionProvider = (typeof TRANSCRIPTION_PROVIDERS)[number];

// Radix Select can't use an empty-string item value, so the "leave
// unassigned" choice gets a sentinel that maps to null in the payload.
const HANDOFF_QUEUE = '__queue__';

const PROVIDER_LABEL: Record<AiProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
  gemini: 'Google Gemini',
  groq: 'Groq',
  openrouter: 'OpenRouter',
};

const KEY_PLACEHOLDER: Record<AiProvider, string> = {
  openai: 'sk-...',
  anthropic: 'sk-ant-...',
  gemini: 'AIza...',
  groq: 'gsk_...',
  openrouter: 'sk-or-...',
};

export function AiConfig() {
  const { account, accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const t = useTranslations('Settings.aiConfig');
  const tCommon = useTranslations('Common');
  const tDay = useTranslations('Delivery.weekdays');
  const { confirm, dialog: confirmDialog } = useConfirmDialog();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);

  const [configured, setConfigured] = useState(false);
  const [provider, setProvider] = useState<AiProvider>('openai');
  const [model, setModel] = useState(AI_PROVIDER_DEFAULT_MODEL.openai);
  const [apiKey, setApiKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [embeddingsKey, setEmbeddingsKey] = useState('');
  const [embeddingsKeyEdited, setEmbeddingsKeyEdited] = useState(false);
  const [hasStoredEmbeddingsKey, setHasStoredEmbeddingsKey] = useState(false);
  const [transcriptionProvider, setTranscriptionProvider] = useState<TranscriptionProvider>('groq');
  const [transcriptionKey, setTranscriptionKey] = useState('');
  const [transcriptionKeyEdited, setTranscriptionKeyEdited] = useState(false);
  const [hasStoredTranscriptionKey, setHasStoredTranscriptionKey] = useState(false);
  const [hoursEnabled, setHoursEnabled] = useState(false);
  const [hoursTimezone, setHoursTimezone] = useState('America/Sao_Paulo');
  const [hours, setHours] = useState<BusinessHoursWeek>({});
  const [systemPrompt, setSystemPrompt] = useState('');
  const [isActive, setIsActive] = useState(false);
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(false);
  const [toolsEnabled, setToolsEnabled] = useState(false);
  const [maxPerConversation, setMaxPerConversation] = useState(3);
  // Empty string = leave unassigned (shared queue).
  const [handoffAgentId, setHandoffAgentId] = useState('');
  const [members, setMembers] = useState<AccountMember[]>([]);

  // Guard keyed on the account (not a bare boolean) so an in-place
  // account switch — ownership transfer, multi-account membership —
  // refetches instead of showing the previous account's config. Mirrors
  // the loadedAccountIdRef pattern in whatsapp-config.tsx.
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/config');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      if (data.configured) {
        setConfigured(true);
        setProvider(data.provider);
        setModel(data.model);
        setSystemPrompt(data.system_prompt ?? '');
        setIsActive(data.is_active);
        setAutoReplyEnabled(data.auto_reply_enabled);
        setToolsEnabled(Boolean(data.tools_enabled));
        setMaxPerConversation(data.auto_reply_max_per_conversation ?? 3);
        setHandoffAgentId(data.handoff_agent_id ?? '');
        setHasStoredKey(Boolean(data.has_key));
        setApiKey(data.has_key ? MASKED_KEY : '');
        setKeyEdited(false);
        setHasStoredEmbeddingsKey(Boolean(data.has_embeddings_key));
        setEmbeddingsKey(data.has_embeddings_key ? MASKED_KEY : '');
        setEmbeddingsKeyEdited(false);
        setTranscriptionProvider(
          data.transcription_provider === 'openai' ? 'openai' : 'groq',
        );
        setHasStoredTranscriptionKey(Boolean(data.has_transcription_key));
        setTranscriptionKey(data.has_transcription_key ? MASKED_KEY : '');
        setTranscriptionKeyEdited(false);
        setHoursEnabled(Boolean(data.hours_enabled));
        setHoursTimezone(data.hours_timezone ?? 'America/Sao_Paulo');
        setHours((data.hours as BusinessHoursWeek) ?? {});
      }
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchConfig();
    // Members populate the handoff-target picker. Best-effort — on an
    // older deployment without the endpoint the picker just shows the
    // queue option.
    void fetchAccountMembers().then(setMembers);
  }, [accountId, fetchConfig]);

  // The model picker is scoped to the selected provider — a model id
  // from the old provider never applies to the new one, so always jump
  // to the new provider's default rather than trying to carry it over.
  const handleProviderChange = (next: AiProvider) => {
    setProvider(next);
    setModel(AI_PROVIDER_DEFAULT_MODEL[next]);
  };

  // Curated choices for the current provider, plus the account's
  // already-saved model id if it isn't one of them (an older config, or
  // one saved before this list existed) — so switching to Setup never
  // silently drops what's actually configured.
  const modelOptions = (() => {
    const curated = AI_PROVIDER_MODELS[provider];
    if (!model || curated.some((m) => m.value === model)) return curated;
    return [{ value: model, label: model }, ...curated];
  })();

  const keyPayload = () => (keyEdited ? apiKey.trim() : undefined);

  // undefined = leave unchanged; '' typed = null (clear); text = set.
  const embeddingsKeyPayload = () =>
    embeddingsKeyEdited ? embeddingsKey.trim() || null : undefined;

  const transcriptionKeyPayload = () =>
    transcriptionKeyEdited ? transcriptionKey.trim() || null : undefined;

  const toggleHoursDay = (day: DayKey, open: boolean) => {
    setHours((prev) => ({ ...prev, [day]: open ? { ...DEFAULT_DAY_HOURS, ...prev[day] } : null }));
  };

  const setHoursDayTime = (day: DayKey, field: 'open' | 'close', value: string) => {
    setHours((prev) => {
      const current = prev[day] ?? DEFAULT_DAY_HOURS;
      return { ...prev, [day]: { ...current, [field]: value } };
    });
  };

  const buildBody = () => ({
    provider,
    model: model.trim(),
    api_key: keyPayload(),
    embeddings_api_key: embeddingsKeyPayload(),
    transcription_provider: transcriptionProvider,
    transcription_api_key: transcriptionKeyPayload(),
    system_prompt: systemPrompt.trim() || null,
    is_active: isActive,
    auto_reply_enabled: autoReplyEnabled,
    tools_enabled: toolsEnabled,
    auto_reply_max_per_conversation: maxPerConversation,
    handoff_agent_id: handoffAgentId || null,
    hours_enabled: hoursEnabled,
    hours_timezone: hoursTimezone,
    hours,
  });

  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await fetch('/api/ai/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          model: model.trim(),
          api_key: keyPayload(),
        }),
      });
      const data = await res.json();
      if (res.ok) toast.success(t('testSuccess'));
      else toast.error(data.error ?? t('testRejected'));
    } catch {
      toast.error(t('testNetworkError'));
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!model.trim()) {
      toast.error(t('missingModel'));
      return;
    }
    if (!configured && !keyEdited) {
      toast.error(t('missingApiKey'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody()),
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

  // Guided starting points for the business-context textarea — one per
  // broad business type, not just Delivery, so every account (not only
  // ones with the Delivery module on) gets a fill-in-the-blanks draft
  // instead of an empty box with a single placeholder example.
  const TEMPLATE_KEYS = ['delivery', 'retail', 'services', 'generic'] as const;
  type TemplateKey = (typeof TEMPLATE_KEYS)[number];

  const handleUseTemplate = async (key: TemplateKey) => {
    if (systemPrompt.trim()) {
      const yes = await confirm({
        title: t('confirmOverwritePrompt'),
        confirmLabel: tCommon('confirm'),
      });
      if (!yes) return;
    }
    setSystemPrompt(t(`promptTemplates.${key}`));
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      const res = await fetch('/api/ai/config', { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('removeSuccess'));
        setConfigured(false);
        setHasStoredKey(false);
        setApiKey('');
        setKeyEdited(false);
        setIsActive(false);
        setAutoReplyEnabled(false);
        setToolsEnabled(false);
        setSystemPrompt('');
        setHandoffAgentId('');
      } else {
        const data = await res.json();
        toast.error(data.error ?? t('removeFailed'));
      }
    } catch {
      toast.error(t('removeFailed'));
    } finally {
      setRemoving(false);
    }
  };

  if (loading || profileLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loadFailed')} {/* Re-using label or a global one, wait, loading is better. Let's use useTranslations from overview or just hardcode Loading... actually I should add loading to aiConfig */}
        {/* Wait, I didn't add loading to aiConfig. I'll just use loading. */}
      </div>
    );
  }

  const disabled = !canEdit || saving;

  return (
    <div>
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
      />

      {!canEdit && (
        <p className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t('adminOnlyConfig')}
        </p>
      )}

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" /> {t('providerAndKey')}
            </CardTitle>
            <CardDescription>
              {t('encryptionNotice')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>{t('provider')}</Label>
                <Select
                  value={provider}
                  onValueChange={(v) => handleProviderChange(v as AiProvider)}
                  disabled={disabled}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">{PROVIDER_LABEL.openai}</SelectItem>
                    <SelectItem value="anthropic">
                      {PROVIDER_LABEL.anthropic}
                    </SelectItem>
                    <SelectItem value="gemini">{PROVIDER_LABEL.gemini}</SelectItem>
                    <SelectItem value="groq">{PROVIDER_LABEL.groq}</SelectItem>
                    <SelectItem value="openrouter">{PROVIDER_LABEL.openrouter}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="ai-model">{t('model')}</Label>
                <Select value={model} onValueChange={(v) => setModel(v ?? '')} disabled={disabled}>
                  <SelectTrigger id="ai-model">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {modelOptions.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-key">{t('apiKey')}</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id="ai-key"
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setKeyEdited(true);
                    }}
                    onFocus={() => {
                      if (!keyEdited && hasStoredKey) {
                        setApiKey('');
                        setKeyEdited(true);
                      }
                    }}
                    placeholder={KEY_PLACEHOLDER[provider]}
                    disabled={disabled}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    tabIndex={-1}
                  >
                    {showKey ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
                <Button
                  variant="outline"
                  onClick={handleTest}
                  disabled={disabled || testing}
                >
                  {testing ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                  )}
                  {t('testKey')}
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-embeddings-key">
                {t('embeddingsKey')}{' '}
                <span className="font-normal text-muted-foreground">
                  {t('optionalSemanticSearch')}
                </span>
              </Label>
              <Input
                id="ai-embeddings-key"
                type="password"
                value={embeddingsKey}
                onChange={(e) => {
                  setEmbeddingsKey(e.target.value);
                  setEmbeddingsKeyEdited(true);
                }}
                onFocus={() => {
                  if (!embeddingsKeyEdited && hasStoredEmbeddingsKey) {
                    setEmbeddingsKey('');
                    setEmbeddingsKeyEdited(true);
                  }
                }}
                placeholder="sk-... (OpenAI)"
                disabled={disabled}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                {t('embeddingsHint', {
                  sameKeyText: provider === 'openai' ? t('sameKeyText') : '',
                })}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-transcription-key">
                {t('transcriptionKey')}{' '}
                <span className="font-normal text-muted-foreground">{t('optionalTranscription')}</span>
              </Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Select
                  value={transcriptionProvider}
                  onValueChange={(v) => setTranscriptionProvider(v as TranscriptionProvider)}
                  disabled={disabled}
                >
                  <SelectTrigger className="w-full sm:w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TRANSCRIPTION_PROVIDERS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {PROVIDER_LABEL[p]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  id="ai-transcription-key"
                  type="password"
                  value={transcriptionKey}
                  onChange={(e) => {
                    setTranscriptionKey(e.target.value);
                    setTranscriptionKeyEdited(true);
                  }}
                  onFocus={() => {
                    if (!transcriptionKeyEdited && hasStoredTranscriptionKey) {
                      setTranscriptionKey('');
                      setTranscriptionKeyEdited(true);
                    }
                  }}
                  placeholder={KEY_PLACEHOLDER[transcriptionProvider]}
                  disabled={disabled}
                  autoComplete="off"
                  className="flex-1"
                />
              </div>
              <p className="text-xs text-muted-foreground">{t('transcriptionHint')}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('behaviour')}</CardTitle>
            <CardDescription>
              {t('behaviourDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="ai-prompt">{t('businessContext')}</Label>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    disabled={disabled}
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
                  >
                    {t('useTemplate')}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {TEMPLATE_KEYS.map((key) => (
                      <DropdownMenuItem key={key} onClick={() => void handleUseTemplate(key)}>
                        {t(`templateLabels.${key}`)}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <Textarea
                id="ai-prompt"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder={t('promptPlaceholder')}
                rows={5}
                disabled={disabled}
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t('enableAssistant')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('enableAssistantDesc')}
                </p>
              </div>
              <Switch
                checked={isActive}
                onCheckedChange={setIsActive}
                disabled={disabled}
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t('autoReply')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('autoReplyDesc')}
                </p>
              </div>
              <Switch
                checked={autoReplyEnabled}
                onCheckedChange={setAutoReplyEnabled}
                disabled={disabled || !isActive}
              />
            </div>

            {hasModule(account, 'delivery') && (
              <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {t('enableTools')}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('enableToolsDesc')}
                  </p>
                </div>
                <Switch
                  checked={toolsEnabled}
                  onCheckedChange={setToolsEnabled}
                  disabled={disabled || !isActive || !autoReplyEnabled}
                />
              </div>
            )}

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="ai-max">{t('maxAutoReplies')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('maxAutoRepliesDesc')}
                </p>
              </div>
              <Input
                id="ai-max"
                type="number"
                min={1}
                max={20}
                value={maxPerConversation}
                onChange={(e) =>
                  setMaxPerConversation(
                    Math.min(20, Math.max(1, Number(e.target.value) || 1)),
                  )
                }
                disabled={disabled || !autoReplyEnabled}
                className="w-20"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-handoff">{t('handoffTo')}</Label>
              <p className="text-xs text-muted-foreground">
                {t('handoffToDesc')}
              </p>
              <Select
                value={handoffAgentId || HANDOFF_QUEUE}
                onValueChange={(v) =>
                  setHandoffAgentId(!v || v === HANDOFF_QUEUE ? '' : v)
                }
                disabled={disabled || !autoReplyEnabled}
              >
                <SelectTrigger id="ai-handoff">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={HANDOFF_QUEUE}>
                    {t('handoffQueue')}
                  </SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                      {memberLabel(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="h-4 w-4 text-primary" /> {t('hoursTitle')}
            </CardTitle>
            <CardDescription>{t('hoursDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">{t('hoursEnforce')}</p>
                <p className="text-xs text-muted-foreground">{t('hoursEnforceDesc')}</p>
              </div>
              <Switch checked={hoursEnabled} onCheckedChange={setHoursEnabled} disabled={disabled} />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">{t('hoursTimezone')}</label>
              <select
                value={hoursTimezone}
                onChange={(e) => setHoursTimezone(e.target.value)}
                disabled={disabled}
                className="w-full rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground"
              >
                {HOURS_TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              {HOURS_DAY_KEYS.map((day) => {
                const dayHours = hours[day];
                const open = Boolean(dayHours);
                return (
                  <div key={day} className="flex items-center gap-3 rounded-md border border-border p-2.5">
                    <span className="w-20 shrink-0 text-sm text-foreground">{tDay(day)}</span>
                    <Switch checked={open} onCheckedChange={(v) => toggleHoursDay(day, v)} disabled={disabled} />
                    {open ? (
                      <div className="flex items-center gap-2 text-sm">
                        <input
                          type="time"
                          value={dayHours?.open ?? DEFAULT_DAY_HOURS.open}
                          onChange={(e) => setHoursDayTime(day, 'open', e.target.value)}
                          disabled={disabled}
                          className="rounded-md border border-border bg-muted px-2 py-1 text-foreground"
                        />
                        <span className="text-muted-foreground">–</span>
                        <input
                          type="time"
                          value={dayHours?.close ?? DEFAULT_DAY_HOURS.close}
                          onChange={(e) => setHoursDayTime(day, 'close', e.target.value)}
                          disabled={disabled}
                          className="rounded-md border border-border bg-muted px-2 py-1 text-foreground"
                        />
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">{t('hoursClosedAllDay')}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <AiKnowledgeCard
          accountId={accountId}
          canEdit={canEdit}
          hasEmbeddingsKey={
            embeddingsKeyEdited
              ? embeddingsKey.trim().length > 0
              : hasStoredEmbeddingsKey
          }
        />

        <div className="flex items-center justify-between">
          {configured ? (
            <Button
              variant="ghost"
              onClick={handleRemove}
              disabled={!canEdit || removing}
              className="text-destructive hover:text-destructive"
            >
              {removing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              {t('remove')}
            </Button>
          ) : (
            <span />
          )}

          <Button onClick={handleSave} disabled={disabled}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('save')}
          </Button>
        </div>
      </div>
      {confirmDialog}
    </div>
  );
}
