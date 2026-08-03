'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { toast } from 'sonner';
import {
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  AlertTriangle,
  RotateCcw,
  QrCode,
  Smartphone,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SettingsPanelHead } from './settings-panel-head';
import type { WhatsAppConfig as WhatsAppConfigType } from '@/types';

export function WhatsAppConfig() {
  const t = useTranslations('Settings.whatsapp');
  const supabase = createClient();
  // whatsapp_config is one-row-per-account. We pull `accountId` straight
  // off the auth context and key every read off it — so a teammate who
  // just joined an account sees the inviter's connection without having
  // to redo anything.
  const { user, accountId, loading: authLoading, profileLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [resetting, setResetting] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [config, setConfig] = useState<WhatsAppConfigType | null>(null);
  // Guards against re-hydrating the form when the load effect below
  // re-runs for reasons unrelated to actually switching accounts —
  // e.g. Supabase's onAuthStateChange fires a token refresh (new
  // `user` object, profileLoading flips true/false) when the browser
  // tab regains focus. Without this, that churn calls fetchConfig()
  // again mid-pairing.
  const loadedAccountIdRef = useRef<string | null>(null);

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

  const fetchConfig = useCallback(async (acctId: string) => {
    setLoading(true);
    try {
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
        setWuzapiPairingState(data.status === 'connected' ? 'connected' : 'idle');
      } else {
        setConfig(null);
        setWuzapiPairingState('idle');
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

  async function handleConfirmReset() {
    try {
      setResetting(true);
      const res = await fetch('/api/whatsapp/config', { method: 'DELETE' });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || t('resetFailed'));
        return;
      }

      toast.success(t('resetSuccess'));
      setConfig(null);
      setWuzapiPairingState('idle');
      setShowResetDialog(false);
    } catch (err) {
      console.error('Reset error:', err);
      toast.error(t('resetFailed'));
    } finally {
      setResetting(false);
    }
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

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t("title")}
        description={t("description")}
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      {/* Main config form */}
      <div className="space-y-6">
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
              onClick={() => setShowResetDialog(true)}
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
      </div>

      {/* Setup Instructions Sidebar */}
      <div>
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
      </div>
    </div>
    <Dialog
      open={showResetDialog}
      onOpenChange={(open) => {
        if (!open && !resetting) setShowResetDialog(false);
      }}
    >
      <DialogContent className="bg-popover border-border sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-popover-foreground">
            <AlertTriangle className="size-4 text-amber-400" />
            {t('resetDialogTitle')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t.rich('resetDialogDesc', {
              bold: (chunks: React.ReactNode) => <strong>{chunks}</strong>,
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="bg-popover border-border">
          <Button
            variant="outline"
            onClick={() => setShowResetDialog(false)}
            disabled={resetting}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t('resetDialogCancel')}
          </Button>
          <Button
            onClick={handleConfirmReset}
            disabled={resetting}
            className="bg-red-600 hover:bg-red-700 text-white"
          >
            {resetting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('resetting')}
              </>
            ) : (
              t('resetDialogConfirm')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </section>
  );
}
