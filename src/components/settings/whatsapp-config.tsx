'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Eye,
  EyeOff,
  Copy,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  Zap,
  AlertTriangle,
  RotateCcw,
  QrCode,
  Smartphone,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SettingsPanelHead } from './settings-panel-head';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import type { WhatsAppConfig as WhatsAppConfigType } from '@/types';

const MASKED_TOKEN = '••••••••••••••••';

type ConnectionStatus = 'connected' | 'disconnected' | 'unknown';
type ResetReason = 'token_corrupted' | 'meta_api_error' | null;

export function WhatsAppConfig() {
  const t = useTranslations('Settings.whatsapp');
  const supabase = createClient();
  // After multi-user, whatsapp_config is one-row-per-account, not
  // one-row-per-user. We pull `accountId` straight off the auth
  // context and key every read off it — so a teammate who just
  // joined an account sees the inviter's saved config without
  // having to re-enter anything.
  const { user, accountId, loading: authLoading, profileLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [config, setConfig] = useState<WhatsAppConfigType | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('unknown');
  const [resetReason, setResetReason] = useState<ResetReason>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');
  // Guards against re-hydrating the form when the load effect below
  // re-runs for reasons unrelated to actually switching accounts —
  // e.g. Supabase's onAuthStateChange fires a token refresh (new
  // `user` object, profileLoading flips true/false) when the browser
  // tab regains focus. Without this, that churn calls fetchConfig()
  // again and overwrites whatever the user typed but hadn't saved yet.
  const loadedAccountIdRef = useRef<string | null>(null);

  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [pin, setPin] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);

  // Channel type — 'meta' (Cloud API, existing form below) or
  // 'wuzapi' (self-hosted, QR pairing). Defaults to 'meta' so an
  // account with no saved config yet sees the familiar flow first;
  // flips to whatever's saved once fetchConfig resolves.
  const [channelType, setChannelType] = useState<'meta' | 'wuzapi'>('meta');
  // Server URL + admin token are OPERATOR infrastructure (set once via
  // WUZAPI_SERVER_URL / WUZAPI_ADMIN_TOKEN on the server) — customers
  // never see or enter them.
  const [wuzapiProvisioning, setWuzapiProvisioning] = useState(false);
  type WuzapiPairingState =
    | 'idle'
    | 'connecting'
    | 'qr_pending'
    | 'logging_in'
    | 'connected'
    | 'error';
  const [wuzapiPairingState, setWuzapiPairingState] = useState<WuzapiPairingState>('idle');
  const [wuzapiQrCode, setWuzapiQrCode] = useState<string | null>(null);
  const [wuzapiError, setWuzapiError] = useState<string>('');
  const wuzapiPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // True once /register has succeeded on Meta's side (timestamp set
  // in the row). When false, the saved config is metadata-only and
  // Meta will silently drop every inbound event — that's the
  // multi-number bug that prompted this work.
  const isRegistered = Boolean(config?.registered_at);
  const lastRegistrationError = config?.last_registration_error ?? null;

  const [verifyingRegistration, setVerifyingRegistration] = useState(false);
  type RegistrationProbe = {
    live: boolean;
    checks: Record<string, boolean | null>;
    errors?: string[];
    last_registration_error?: string | null;
    registered_at?: string | null;
    subscribed_apps_at?: string | null;
  };
  const [registrationProbe, setRegistrationProbe] =
    useState<RegistrationProbe | null>(null);

  const webhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/whatsapp/webhook`
      : '';

  const fetchConfig = useCallback(async (acctId: string) => {
    setLoading(true);
    try {
      // Load form values from Supabase (shows what's in DB).
      // Switched from `user_id` (which would only match the row's
      // original author) to `account_id` so every member of the
      // account sees the same saved configuration. UNIQUE(account_id)
      // on the table guarantees the .maybeSingle() return type
      // remains accurate.
      const { data, error } = await supabase
        .from('whatsapp_config')
        .select('*')
        .eq('account_id', acctId)
        .maybeSingle();

      if (error) {
        console.error('Failed to load config row:', error);
      }

      if (data) {
        setConfig(data);
        setChannelType(data.channel_type === 'wuzapi' ? 'wuzapi' : 'meta');
        setPhoneNumberId(data.phone_number_id || '');
        setWabaId(data.waba_id || '');
        setAccessToken(MASKED_TOKEN);
        setVerifyToken('');
        setPin('');
        setTokenEdited(false);
        if (data.channel_type === 'wuzapi') {
          setWuzapiPairingState(data.status === 'connected' ? 'connected' : 'idle');
        }
      } else {
        setConfig(null);
        setChannelType('meta');
        setPhoneNumberId('');
        setWabaId('');
        setAccessToken('');
        setVerifyToken('');
        setPin('');
        setTokenEdited(false);
        setWuzapiPairingState('idle');
      }
      // Clear any stale probe result when reloading the row.
      setRegistrationProbe(null);

      // Then verify health via the API (decrypts token + pings Meta) —
      // Meta-only; WuzAPI's own status polling (below) handles its
      // connection health independently.
      if (data && data.channel_type !== 'wuzapi') {
        try {
          const res = await fetch('/api/whatsapp/config', { method: 'GET' });
          const payload = await res.json();

          if (payload.connected) {
            setConnectionStatus('connected');
            setResetReason(null);
            setStatusMessage('');
          } else {
            setConnectionStatus('disconnected');
            setResetReason(payload.needs_reset ? 'token_corrupted' : payload.reason === 'meta_api_error' ? 'meta_api_error' : null);
            setStatusMessage(payload.message || '');
          }
        } catch (err) {
          console.error('Health check failed:', err);
          setConnectionStatus('disconnected');
        }
      } else {
        setConnectionStatus('disconnected');
        setResetReason(null);
        setStatusMessage('');
      }
    } catch (err) {
      console.error('fetchConfig error:', err);
      toast.error('Failed to load WhatsApp configuration');
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    // Need both the auth session (`!authLoading`) AND the profile
    // (`!profileLoading`, which carries `accountId`). Without the
    // second guard, the effect would fire with `accountId === null`
    // for the first render window and bail without ever retrying
    // once the profile arrives.
    if (authLoading || profileLoading) return;
    if (!user || !accountId) {
      loadedAccountIdRef.current = null;
      setLoading(false);
      return;
    }
    if (loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    fetchConfig(accountId);
  }, [authLoading, profileLoading, user?.id, accountId, fetchConfig]);

  async function handleSave() {
    if (!phoneNumberId.trim()) {
      toast.error('Phone Number ID is required');
      return;
    }
    if (!config && (!accessToken.trim() || !tokenEdited)) {
      toast.error('Access Token is required for initial setup');
      return;
    }

    try {
      setSaving(true);

      // Always POST through the API — it verifies with Meta and encrypts
      // the access_token server-side with ENCRYPTION_KEY. Skipping this
      // and writing direct to Supabase stores the token in plaintext,
      // which then fails decryption on every subsequent health check.
      const payload: Record<string, unknown> = {
        phone_number_id: phoneNumberId.trim(),
        waba_id: wabaId.trim() || null,
        verify_token: verifyToken.trim() || null,
        // Optional — only sent when the user filled it in. The server
        // requires it on first save or when changing numbers; for a
        // simple token rotation, leaving it blank skips re-register.
        pin: pin.trim() || null,
      };

      if (tokenEdited && accessToken !== MASKED_TOKEN && accessToken.trim()) {
        payload.access_token = accessToken.trim();
      } else if (config) {
        // Existing config — reuse stored encrypted token by decrypting on the
        // server. But our POST handler requires an access_token to verify
        // with Meta. If the user didn't change the token, we need to signal
        // that. Simplest: require token re-entry if they're updating.
        toast.error('Please re-enter the Access Token to save changes');
        setSaving(false);
        return;
      }

      const res = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Failed to save configuration');
        setSaving(false);
        return;
      }

      // The route now returns a structured outcome:
      //   * registered=true   → number is live, events will flow
      //   * registered=false  → credentials saved but /register
      //                         failed; UI shows the specific error
      //                         and a retry path. registration_error
      //                         is human-readable from Meta.
      if (data.registered === false && data.registration_error) {
        toast.error(
          `Saved, but Meta couldn't register the number: ${data.registration_error}`,
          { duration: 12000 },
        );
      } else if (data.registration_skipped) {
        // Credentials saved + verified, but /register was skipped
        // because no PIN was supplied (e.g. a Meta test number).
        // Don't claim the number is "Live" — point at the
        // Registration status banner instead.
        toast.success(
          'Credentials saved and verified. Inbound registration was skipped (no PIN) — see Registration status below.',
          { duration: 10000 },
        );
        setPin('');
      } else {
        toast.success(
          data.phone_info?.verified_name
            ? `Live — ${data.phone_info.verified_name} can now receive events.`
            : 'WhatsApp connected. Events will start flowing within a minute.',
        );
        // Clear the PIN so subsequent saves don't accidentally
        // re-register (which would void the active subscription if
        // the PIN became stale).
        setPin('');
      }

      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('Save error:', err);
      toast.error('Failed to save configuration');
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    try {
      setTesting(true);
      const res = await fetch('/api/whatsapp/config', { method: 'GET' });
      const payload = await res.json();

      if (payload.connected) {
        setConnectionStatus('connected');
        setResetReason(null);
        setStatusMessage('');
        toast.success(
          payload.phone_info?.verified_name
            ? `Connected to ${payload.phone_info.verified_name}`
            : 'API connection successful'
        );
      } else {
        setConnectionStatus('disconnected');
        setResetReason(payload.needs_reset ? 'token_corrupted' : payload.reason === 'meta_api_error' ? 'meta_api_error' : null);
        setStatusMessage(payload.message || '');
        toast.error(payload.message || 'API connection failed');
      }
    } catch (err) {
      console.error('Test connection error:', err);
      setConnectionStatus('disconnected');
      toast.error('Connection test failed. Check network and try again.');
    } finally {
      setTesting(false);
    }
  }

  async function handleVerifyRegistration() {
    setVerifyingRegistration(true);
    setRegistrationProbe(null);
    try {
      const res = await fetch('/api/whatsapp/config/verify-registration', {
        method: 'GET',
      });
      const data = (await res.json()) as RegistrationProbe;
      setRegistrationProbe(data);
      if (data.live) {
        toast.success('Number is fully wired — Meta is delivering events.');
      } else {
        toast.error(
          'Number is not fully registered. See the checks below for which step failed.',
          { duration: 8000 },
        );
      }
      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('verify-registration failed:', err);
      toast.error('Could not reach the verification endpoint.');
    } finally {
      setVerifyingRegistration(false);
    }
  }

  async function handleReset() {
    if (!confirm('This will delete the current WhatsApp config so you can re-enter it. Continue?')) {
      return;
    }

    try {
      setResetting(true);
      const res = await fetch('/api/whatsapp/config', { method: 'DELETE' });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Failed to reset configuration');
        return;
      }

      toast.success('Configuration cleared. You can now re-enter your credentials.');
      setConfig(null);
      setPhoneNumberId('');
      setWabaId('');
      setAccessToken('');
      setVerifyToken('');
      setTokenEdited(false);
      setConnectionStatus('disconnected');
      setResetReason(null);
      setStatusMessage('');
    } catch (err) {
      console.error('Reset error:', err);
      toast.error('Failed to reset configuration');
    } finally {
      setResetting(false);
    }
  }

  function handleCopyWebhookUrl() {
    navigator.clipboard.writeText(webhookUrl);
    toast.success('Webhook URL copied to clipboard');
  }

  function stopWuzapiPolling() {
    if (wuzapiPollRef.current) {
      clearInterval(wuzapiPollRef.current);
      wuzapiPollRef.current = null;
    }
  }

  // Stop the poll loop on unmount so a settings-page navigation away
  // mid-pairing doesn't leak an interval hitting the API forever.
  useEffect(() => stopWuzapiPolling, []);

  /**
   * Poll /qr and /status every 2.5s while pairing. Stops itself once
   * logged in, on an unrecoverable error, or after ~2 minutes (a QR
   * code that's gone unscanned that long almost certainly needs a
   * fresh /connect anyway — WuzAPI's own QR has a short server-side
   * lifetime).
   */
  function startWuzapiPolling() {
    stopWuzapiPolling();
    let elapsedMs = 0;
    const intervalMs = 2500;
    const timeoutMs = 120_000;

    wuzapiPollRef.current = setInterval(async () => {
      elapsedMs += intervalMs;
      try {
        const statusRes = await fetch('/api/whatsapp/wuzapi/status');
        const statusData = await statusRes.json();

        if (statusData.logged_in) {
          setWuzapiPairingState('connected');
          setWuzapiQrCode(null);
          stopWuzapiPolling();
          toast.success('WhatsApp connected via WuzAPI.');
          if (accountId) await fetchConfig(accountId);
          return;
        }

        // Not logged in yet — fetch a QR code to display (or refresh
        // it, since WuzAPI's codes rotate periodically until scanned).
        const qrRes = await fetch('/api/whatsapp/wuzapi/qr');
        const qrData = await qrRes.json();
        if (qrData.qr_code) {
          setWuzapiPairingState('qr_pending');
          setWuzapiQrCode(qrData.qr_code);
        } else if (statusData.connected) {
          // Connected but no QR and not logged in yet — WuzAPI is
          // mid-handshake right after /connect.
          setWuzapiPairingState('logging_in');
        }
      } catch (err) {
        console.error('WuzAPI poll error:', err);
      }

      if (elapsedMs >= timeoutMs) {
        stopWuzapiPolling();
        setWuzapiPairingState('error');
        setWuzapiError('Pairing timed out. Click Connect to try again.');
      }
    }, intervalMs);
  }

  async function handleProvisionWuzapi() {
    setWuzapiProvisioning(true);
    setWuzapiError('');
    try {
      // No body needed — the server reads WUZAPI_SERVER_URL /
      // WUZAPI_ADMIN_TOKEN from its own environment and derives the
      // instance name from the account. Nothing customer-facing here.
      const res = await fetch('/api/whatsapp/wuzapi/provision', {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) {
        setWuzapiPairingState('error');
        setWuzapiError(data.error || 'Failed to provision WuzAPI connection');
        toast.error(data.error || 'Failed to provision WuzAPI connection');
        return;
      }
      toast.success('WuzAPI connection created — connecting…');
      if (accountId) await fetchConfig(accountId);
      await handleConnectWuzapi();
    } catch (err) {
      console.error('WuzAPI provision error:', err);
      setWuzapiPairingState('error');
      setWuzapiError('Failed to provision WuzAPI connection');
    } finally {
      setWuzapiProvisioning(false);
    }
  }

  async function handleConnectWuzapi() {
    setWuzapiPairingState('connecting');
    setWuzapiError('');
    try {
      const res = await fetch('/api/whatsapp/wuzapi/connect', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setWuzapiPairingState('error');
        setWuzapiError(data.error || 'Failed to start WuzAPI session');
        toast.error(data.error || 'Failed to start WuzAPI session');
        return;
      }
      setWuzapiPairingState('qr_pending');
      startWuzapiPolling();
    } catch (err) {
      console.error('WuzAPI connect error:', err);
      setWuzapiPairingState('error');
      setWuzapiError('Failed to start WuzAPI session');
    }
  }

  if (loading) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead
          title={t("title")}
          description={t("description")}
        />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      </section>
    );
  }

  const showResetBanner = resetReason === 'token_corrupted';

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t("title")}
        description={t("description")}
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      {/* Main config form */}
      <div className="space-y-6">
        {/* Channel selector — which WhatsApp connection type this
            account uses. Switching does not save by itself; it only
            changes which form below is shown. Meta's form saves via
            handleSave (existing); WuzAPI provisions + pairs via its
            own handlers below. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground text-base">{t('channelTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('channelDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant={channelType === 'meta' ? 'default' : 'outline'}
                onClick={() => setChannelType('meta')}
                className={channelType === 'meta' ? 'bg-primary text-primary-foreground' : 'border-border text-muted-foreground hover:text-foreground hover:bg-muted'}
              >
                {t('channelMeta')}
              </Button>
              <Button
                type="button"
                variant={channelType === 'wuzapi' ? 'default' : 'outline'}
                onClick={() => setChannelType('wuzapi')}
                className={channelType === 'wuzapi' ? 'bg-primary text-primary-foreground' : 'border-border text-muted-foreground hover:text-foreground hover:bg-muted'}
              >
                {t('channelWuzapi')}
              </Button>
            </div>
          </CardContent>
        </Card>

        {channelType === 'meta' && (
        <>
        {/* Corrupted-token reset banner */}
        {showResetBanner && (
          <Alert className="bg-amber-950/40 border-amber-600/40">
            <div className="flex items-start gap-3">
              <AlertTriangle className="size-5 text-amber-400 mt-0.5 shrink-0" />
              <div className="flex-1">
                <AlertTitle className="text-amber-200 mb-1">
                  Stored token can&apos;t be decrypted
                </AlertTitle>
                <AlertDescription className="text-amber-100/80 text-sm">
                  {statusMessage}
                </AlertDescription>
                <Button
                  onClick={handleReset}
                  disabled={resetting}
                  size="sm"
                  className="mt-3 bg-amber-600 hover:bg-amber-700 text-white"
                >
                  {resetting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      {t('resetting')}
                    </>
                  ) : (
                    <>
                      <RotateCcw className="size-4" />
                      {t('resetConfig')}
                    </>
                  )}
                </Button>
              </div>
            </div>
          </Alert>
        )}

        {/* Connection Status */}
        <Alert className="bg-card border-border">
          <div className="flex items-center gap-2">
            {connectionStatus === 'connected' ? (
              <CheckCircle2 className="size-4 text-primary" />
            ) : (
              <XCircle className="size-4 text-red-500" />
            )}
            <AlertTitle className="text-foreground mb-0">
              {connectionStatus === 'connected' ? t('credentialsValid') : t('notConnected')}
            </AlertTitle>
          </div>
          <AlertDescription className="text-muted-foreground">
            {connectionStatus === 'connected'
              ? t('connectedDesc')
              : statusMessage ||
                t('notConnectedDesc')}
          </AlertDescription>
        </Alert>

        {/* Registration Status — the "is it actually live?" check.
            Credentials being valid is necessary but not sufficient;
            without a successful /register call the number won't
            receive inbound events. Surface this dimension separately
            so users don't trust a misleading green banner. */}
        {config && (
          <Alert
            className={
              isRegistered
                ? 'bg-emerald-950/30 border-emerald-700/50'
                : 'bg-amber-950/30 border-amber-700/50'
            }
          >
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                {isRegistered ? (
                  <CheckCircle2 className="size-4 text-emerald-400" />
                ) : (
                  <AlertTriangle className="size-4 text-amber-400" />
                )}
                <AlertTitle
                  className={
                    'mb-0 ' + (isRegistered ? 'text-emerald-200' : 'text-amber-200')
                  }
                >
                  {isRegistered
                    ? t('registered')
                    : t('notRegistered')}
                </AlertTitle>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleVerifyRegistration}
                disabled={verifyingRegistration}
                className="border-border bg-transparent text-foreground hover:bg-muted h-7"
              >
                {verifyingRegistration ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Zap className="size-3.5" />
                )}
                {t('verifyWithMeta')}
              </Button>
            </div>
            <AlertDescription className="text-muted-foreground mt-2 text-xs leading-relaxed">
              {isRegistered ? (
                <span
                  dangerouslySetInnerHTML={{
                    __html: t('subscribedSince', {
                      date: config.registered_at
                        ? new Date(config.registered_at).toLocaleString()
                        : t('unknownDate'),
                    }),
                  }}
                />
              ) : lastRegistrationError ? (
                <>
                  {t('lastAttemptFailed')}
                  <span className="text-red-300">
                    &quot;{lastRegistrationError}&quot;
                  </span>
                  . {t('retryHint')}
                </>
              ) : (
                <>{t('noRegistrationHint')}</>
              )}
            </AlertDescription>

            {registrationProbe && (
              <div className="mt-3 rounded border border-border bg-card/60 px-3 py-2 space-y-1.5 text-[11px]">
                <p className="font-medium text-foreground">
                  {t('diagnosticLastRun')}
                  <span className={registrationProbe.live ? 'text-emerald-400' : 'text-amber-400'}>
                    {registrationProbe.live ? t('live') : t('notLive')}
                  </span>
                </p>
                <ul className="space-y-0.5 text-muted-foreground">
                  {Object.entries(registrationProbe.checks).map(([k, v]) => (
                    <li key={k} className="flex items-center gap-1.5">
                      {v === true ? (
                        <CheckCircle2 className="size-3 text-emerald-400 shrink-0" />
                      ) : v === false ? (
                        <XCircle className="size-3 text-red-400 shrink-0" />
                      ) : (
                        <span className="size-3 rounded-full border border-border shrink-0" />
                      )}
                      <code className="text-muted-foreground">{k}</code>
                    </li>
                  ))}
                </ul>
                {(registrationProbe.errors ?? []).length > 0 && (
                  <ul className="pt-1 space-y-0.5 text-red-300">
                    {registrationProbe.errors?.map((e, i) => (
                      <li key={i}>• {e}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Alert>
        )}

        {/* API Credentials */}
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">{t('apiCredentialsTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('apiCredentialsDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('phoneNumberId')}</Label>
              <Input
                placeholder="e.g. 100234567890123"
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('wabaId')}</Label>
              <Input
                placeholder="e.g. 100234567890456"
                value={wabaId}
                onChange={(e) => setWabaId(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('accessToken')}</Label>
              <div className="relative">
                <Input
                  type={showToken ? 'text' : 'password'}
                  placeholder={t('accessTokenPlaceholder')}
                  value={accessToken}
                  onChange={(e) => {
                    setAccessToken(e.target.value);
                    setTokenEdited(true);
                  }}
                  onFocus={() => {
                    if (accessToken === MASKED_TOKEN) {
                      setAccessToken('');
                      setTokenEdited(true);
                    }
                  }}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              {config && !tokenEdited && (
                <p className="text-xs text-muted-foreground">
                  {t('tokenHidden')}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('webhookVerifyToken')}</Label>
              <Input
                placeholder={t('webhookVerifyTokenPlaceholder')}
                value={verifyToken}
                onChange={(e) => setVerifyToken(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
              <p className="text-xs text-muted-foreground">
                {t('webhookVerifyTokenHint')}
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">
                {t('twoStepPin')}
                <span className="ml-1 text-muted-foreground">{t('optional')}</span>
              </Label>
              <Input
                type="text"
                inputMode="numeric"
                maxLength={6}
                placeholder={t('pinPlaceholder')}
                value={pin}
                onChange={(e) =>
                  setPin(e.target.value.replace(/\D/g, '').slice(0, 6))
                }
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground tracking-widest"
              />
              <p className="text-xs text-muted-foreground leading-relaxed">
                <span dangerouslySetInnerHTML={{ __html: t('pinHint') }} />
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Webhook URL */}
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">{t('webhookTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('webhookDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('webhookUrl')}</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={webhookUrl}
                  className="bg-muted border-border text-muted-foreground font-mono text-sm"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleCopyWebhookUrl}
                  className="shrink-0 border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                >
                  <Copy className="size-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Action Buttons */}
        <div className="flex flex-wrap gap-3">
          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('saving')}
              </>
            ) : (
              t('saveConfig')
            )}
          </Button>
          <Button
            variant="outline"
            onClick={handleTestConnection}
            disabled={testing || !config}
            className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
          >
            {testing ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('testing')}
              </>
            ) : (
              <>
                <Zap className="size-4" />
                {t('testConnection')}
              </>
            )}
          </Button>
          {config && (
            <Button
              variant="outline"
              onClick={handleReset}
              disabled={resetting}
              className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
            >
              {resetting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('resetting')}
                </>
              ) : (
                <>
                  <RotateCcw className="size-4" />
                  {t('resetConfig')}
                </>
              )}
            </Button>
          )}
        </div>
        </>
        )}

        {channelType === 'wuzapi' && (
        <>
        {/* Connection status */}
        <Alert className="bg-card border-border">
          <div className="flex items-center gap-2">
            {wuzapiPairingState === 'connected' ? (
              <CheckCircle2 className="size-4 text-primary" />
            ) : (
              <XCircle className="size-4 text-red-500" />
            )}
            <AlertTitle className="text-foreground mb-0">
              {wuzapiPairingState === 'connected' ? t('wuzapiConnected') : t('wuzapiNotConnected')}
            </AlertTitle>
          </div>
          <AlertDescription className="text-muted-foreground">
            {wuzapiPairingState === 'connected'
              ? t('wuzapiConnectedDesc')
              : wuzapiError || t('wuzapiNotConnectedDesc')}
          </AlertDescription>
        </Alert>

        {/* Pairing */}
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">{t('wuzapiPairingTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('wuzapiPairingDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {wuzapiPairingState === 'connected' ? (
              <div className="flex items-center gap-2 text-emerald-400">
                <Smartphone className="size-5" />
                <span className="text-sm">{t('wuzapiPairedHint')}</span>
              </div>
            ) : wuzapiQrCode && wuzapiPairingState === 'qr_pending' ? (
              <div className="flex flex-col items-center gap-3 py-2">
                {/* eslint-disable-next-line @next/next/no-img-element -- data: URI from WuzAPI, not a Next-optimizable remote asset */}
                <img src={wuzapiQrCode} alt={t('wuzapiQrAlt')} className="size-56 rounded border border-border bg-white p-2" />
                <p className="text-xs text-muted-foreground text-center max-w-xs">{t('wuzapiScanHint')}</p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {wuzapiPairingState === 'connecting' || wuzapiPairingState === 'logging_in'
                  ? t('wuzapiWaitingHint')
                  : t('wuzapiIdleHint')}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Actions */}
        <div className="flex flex-wrap gap-3">
          {wuzapiPairingState !== 'connected' && !config?.wuzapi_instance_name && (
            <Button
              onClick={handleProvisionWuzapi}
              disabled={wuzapiProvisioning}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {wuzapiProvisioning ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('wuzapiProvisioning')}
                </>
              ) : (
                <>
                  <QrCode className="size-4" />
                  {t('wuzapiConnectButton')}
                </>
              )}
            </Button>
          )}
          {config?.wuzapi_instance_name && wuzapiPairingState !== 'connected' && (
            <Button
              onClick={handleConnectWuzapi}
              disabled={wuzapiPairingState === 'connecting' || wuzapiPairingState === 'qr_pending'}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {wuzapiPairingState === 'connecting' || wuzapiPairingState === 'qr_pending' ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('wuzapiConnecting')}
                </>
              ) : (
                <>
                  <QrCode className="size-4" />
                  {t('wuzapiRetryButton')}
                </>
              )}
            </Button>
          )}
          {config?.wuzapi_instance_name && (
            <Button
              variant="outline"
              onClick={handleReset}
              disabled={resetting}
              className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
            >
              {resetting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('resetting')}
                </>
              ) : (
                <>
                  <RotateCcw className="size-4" />
                  {t('resetConfig')}
                </>
              )}
            </Button>
          )}
        </div>
        </>
        )}
      </div>

      {/* Setup Instructions Sidebar */}
      <div>
        {channelType === 'meta' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground text-base">{t('setupInstructions')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('setupInstructionsDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Accordion>
              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">1</span>
                    {t('step1')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li dangerouslySetInnerHTML={{ __html: t('step1_1') }} />
                    <li>{t('step1_2')}</li>
                    <li>{t('step1_3')}</li>
                    <li>{t('step1_4')}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">2</span>
                    {t('step2')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>{t('step2_1')}</li>
                    <li>{t('step2_2')}</li>
                    <li>{t('step2_3')}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">3</span>
                    {t('step3')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>{t('step3_1')}</li>
                    <li dangerouslySetInnerHTML={{ __html: t('step3_2') }} />
                    <li dangerouslySetInnerHTML={{ __html: t('step3_3') }} />
                    <li dangerouslySetInnerHTML={{ __html: t('step3_4') }} />
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">4</span>
                    {t('step4')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>{t('step4_1')}</li>
                    <li>{t('step4_2')}</li>
                    <li dangerouslySetInnerHTML={{ __html: t('step4_3') }} />
                    <li dangerouslySetInnerHTML={{ __html: t('step4_4') }} />
                    <li>{t('step4_5')}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>
            </Accordion>

            <div className="mt-4 pt-4 border-t border-border">
              <a
                href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors"
              >
                <ExternalLink className="size-3.5" />
                {t('metaDocs')}
              </a>
            </div>
          </CardContent>
        </Card>
        )}

        {channelType === 'wuzapi' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground text-base">{t('wuzapiSetupTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('wuzapiSetupDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground">
              <li>{t('wuzapiSetupStep1')}</li>
              <li>{t('wuzapiSetupStep2')}</li>
              <li>{t('wuzapiSetupStep3')}</li>
              <li>{t('wuzapiSetupStep4')}</li>
            </ol>
            <div className="mt-4 pt-4 border-t border-border">
              <a
                href="https://github.com/asternic/wuzapi"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors"
              >
                <ExternalLink className="size-3.5" />
                {t('wuzapiDocs')}
              </a>
            </div>
          </CardContent>
        </Card>
        )}
      </div>
    </div>
    </section>
  );
}
