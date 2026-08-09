'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, CreditCard, Trash2, Eye, EyeOff, QrCode } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

const MASKED_SECRET = '••••••••••••••••';

export function PaymentConfig() {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const t = useTranslations('Settings.payment');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  const [configured, setConfigured] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [publicKey, setPublicKey] = useState('');
  const [pixKey, setPixKey] = useState('');

  const [accessToken, setAccessToken] = useState('');
  const [accessTokenEdited, setAccessTokenEdited] = useState(false);
  const [showAccessToken, setShowAccessToken] = useState(false);
  const [hasStoredAccessToken, setHasStoredAccessToken] = useState(false);

  const [webhookSecret, setWebhookSecret] = useState('');
  const [webhookSecretEdited, setWebhookSecretEdited] = useState(false);
  const [showWebhookSecret, setShowWebhookSecret] = useState(false);
  const [hasStoredWebhookSecret, setHasStoredWebhookSecret] = useState(false);

  // Same guard as ai-config.tsx's loadedAccountIdRef — avoids
  // refetching (and overwriting an in-progress edit) on churn unrelated
  // to actually switching accounts.
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/payments/config');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      if (data.configured) {
        setConfigured(true);
        setEnabled(Boolean(data.enabled));
        setPublicKey(data.mp_public_key ?? '');
        setHasStoredAccessToken(Boolean(data.has_access_token));
        setAccessToken(data.has_access_token ? MASKED_SECRET : '');
        setAccessTokenEdited(false);
        setHasStoredWebhookSecret(Boolean(data.has_webhook_secret));
        setWebhookSecret(data.has_webhook_secret ? MASKED_SECRET : '');
        setWebhookSecretEdited(false);
      }
      setPixKey(data.pix_key ?? '');
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

  const accessTokenPayload = () => (accessTokenEdited ? accessToken.trim() : undefined);
  const webhookSecretPayload = () => (webhookSecretEdited ? webhookSecret.trim() : undefined);

  const handleSave = async () => {
    // MP credentials are only required when actually turning checkout
    // on — saving just a Pix key (checkout left off) never needs them.
    // Checked against hasStoredAccessToken/hasStoredWebhookSecret, not
    // `configured` — a row can already exist from a Pix-key-only save
    // with no MP credentials in it at all.
    if (enabled && !hasStoredAccessToken && !accessTokenEdited) {
      toast.error(t('missingAccessToken'));
      return;
    }
    if (enabled && !hasStoredWebhookSecret && !webhookSecretEdited) {
      toast.error(t('missingWebhookSecret'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/payments/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled,
          mp_public_key: publicKey.trim() || null,
          mp_access_token: accessTokenPayload(),
          mp_webhook_secret: webhookSecretPayload(),
          pix_key: pixKey.trim() || null,
        }),
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

  const handleRemove = async () => {
    setRemoving(true);
    try {
      const res = await fetch('/api/payments/config', { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('removeSuccess'));
        setConfigured(false);
        setEnabled(false);
        setPublicKey('');
        setAccessToken('');
        setAccessTokenEdited(false);
        setHasStoredAccessToken(false);
        setWebhookSecret('');
        setWebhookSecretEdited(false);
        setHasStoredWebhookSecret(false);
        setPixKey('');
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
              <QrCode className="h-4 w-4 text-primary" /> {t('pixTitle')}
            </CardTitle>
            <CardDescription>{t('pixDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Label htmlFor="pix-key">{t('pixKeyLabel')}</Label>
            <Input
              id="pix-key"
              value={pixKey}
              onChange={(e) => setPixKey(e.target.value)}
              placeholder="45999526657"
              disabled={disabled}
            />
            <p className="text-xs text-muted-foreground">{t('pixKeyHint')}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CreditCard className="h-4 w-4 text-primary" /> {t('credentials')}
            </CardTitle>
            <CardDescription>{t('encryptionNotice')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="mp-access-token">{t('accessToken')}</Label>
              <div className="relative">
                <Input
                  id="mp-access-token"
                  type={showAccessToken ? 'text' : 'password'}
                  value={accessToken}
                  onChange={(e) => {
                    setAccessToken(e.target.value);
                    setAccessTokenEdited(true);
                  }}
                  onFocus={() => {
                    if (!accessTokenEdited && hasStoredAccessToken) {
                      setAccessToken('');
                      setAccessTokenEdited(true);
                    }
                  }}
                  placeholder="APP_USR-..."
                  disabled={disabled}
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setShowAccessToken((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                >
                  {showAccessToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="mp-webhook-secret">{t('webhookSecret')}</Label>
              <div className="relative">
                <Input
                  id="mp-webhook-secret"
                  type={showWebhookSecret ? 'text' : 'password'}
                  value={webhookSecret}
                  onChange={(e) => {
                    setWebhookSecret(e.target.value);
                    setWebhookSecretEdited(true);
                  }}
                  onFocus={() => {
                    if (!webhookSecretEdited && hasStoredWebhookSecret) {
                      setWebhookSecret('');
                      setWebhookSecretEdited(true);
                    }
                  }}
                  placeholder="whsec_..."
                  disabled={disabled}
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setShowWebhookSecret((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                >
                  {showWebhookSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">{t('webhookSecretHint')}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="mp-public-key">{t('publicKey')}</Label>
              <Input
                id="mp-public-key"
                value={publicKey}
                onChange={(e) => setPublicKey(e.target.value)}
                placeholder="APP_USR-..."
                disabled={disabled}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('behaviour')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">{t('enableCheckout')}</p>
                <p className="text-xs text-muted-foreground">{t('enableCheckoutDesc')}</p>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} disabled={disabled} />
            </div>
          </CardContent>
        </Card>

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
    </div>
  );
}
