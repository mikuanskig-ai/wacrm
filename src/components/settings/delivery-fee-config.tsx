'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Truck, Plus, X, Route, MapPin } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import type { DeliveryFeeFailureReason } from '@/lib/delivery/fee-engine';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsPanelHead } from './settings-panel-head';
import { useTranslations } from 'next-intl';
import type { DeliveryMethod } from '@/lib/delivery/fee-engine';

interface NeighborhoodRow {
  id: string;
  name: string;
  price: string;
}

interface RangeRow {
  from: string;
  to: string;
  price: string;
}

const METHODS: DeliveryMethod[] = ['fixed', 'neighborhood', 'distance_range', 'per_km'];

// Structured fields — not a single free-text blob — are what let the
// geocoder reliably resolve small Brazilian towns. A same-named
// street matched in the WRONG state when sent as one string; giving
// city/state as separate fields resolved the right one. See
// providers/openrouteservice.ts's header comment for the full story.
const BR_STATES = [
  ['AC', 'Acre'], ['AL', 'Alagoas'], ['AP', 'Amapá'], ['AM', 'Amazonas'],
  ['BA', 'Bahia'], ['CE', 'Ceará'], ['DF', 'Distrito Federal'], ['ES', 'Espírito Santo'],
  ['GO', 'Goiás'], ['MA', 'Maranhão'], ['MT', 'Mato Grosso'], ['MS', 'Mato Grosso do Sul'],
  ['MG', 'Minas Gerais'], ['PA', 'Pará'], ['PB', 'Paraíba'], ['PR', 'Paraná'],
  ['PE', 'Pernambuco'], ['PI', 'Piauí'], ['RJ', 'Rio de Janeiro'], ['RN', 'Rio Grande do Norte'],
  ['RS', 'Rio Grande do Sul'], ['RO', 'Rondônia'], ['RR', 'Roraima'], ['SC', 'Santa Catarina'],
  ['SP', 'São Paulo'], ['SE', 'Sergipe'], ['TO', 'Tocantins'],
] as const;

type SimResult =
  | { ok: true; fee: number; distanceKm: number | null; freeShipping: boolean }
  | { ok: false; reason: DeliveryFeeFailureReason };

export function DeliveryFeeConfig() {
  const { accountId, accountRole, defaultCurrency, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const t = useTranslations('Settings.deliveryFee');

  const [simAddress, setSimAddress] = useState('');
  const [simSubtotal, setSimSubtotal] = useState('');
  const [simulating, setSimulating] = useState(false);
  const [simResult, setSimResult] = useState<SimResult | null>(null);

  const formatFee = (value: number) => {
    try {
      return new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: defaultCurrency || 'BRL',
      }).format(value);
    } catch {
      return value.toFixed(2);
    }
  };

  async function runSimulation() {
    setSimulating(true);
    setSimResult(null);
    try {
      const res = await fetch('/api/delivery/fee/calculate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: simAddress.trim() || undefined,
          subtotal: Number(simSubtotal.replace(',', '.')) || 0,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('simulator.simulateFailed'));
        return;
      }
      setSimResult(data as SimResult);
    } catch {
      toast.error(t('simulator.simulateFailed'));
    } finally {
      setSimulating(false);
    }
  }

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [method, setMethod] = useState<DeliveryMethod>('fixed');
  const [maxDistance, setMaxDistance] = useState('');
  const [freeShippingAbove, setFreeShippingAbove] = useState('');
  const [originStreet, setOriginStreet] = useState('');
  const [originNeighbourhood, setOriginNeighbourhood] = useState('');
  const [originCity, setOriginCity] = useState('');
  const [originState, setOriginState] = useState('');
  const [originPostalCode, setOriginPostalCode] = useState('');
  const [resolvedLabel, setResolvedLabel] = useState<string | null>(null);

  const [fixedPrice, setFixedPrice] = useState('0');
  const [neighborhoods, setNeighborhoods] = useState<NeighborhoodRow[]>([]);
  const [ranges, setRanges] = useState<RangeRow[]>([]);
  const [basePrice, setBasePrice] = useState('0');
  const [pricePerKm, setPricePerKm] = useState('0');

  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/delivery/fee-config');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      if (data.configured) {
        setMethod(data.delivery_method as DeliveryMethod);
        setMaxDistance(data.max_distance != null ? String(data.max_distance) : '');
        setFreeShippingAbove(data.free_shipping_above != null ? String(data.free_shipping_above) : '');
        setOriginStreet(data.origin_street ?? '');
        setOriginNeighbourhood(data.origin_neighbourhood ?? '');
        setOriginCity(data.origin_city ?? '');
        setOriginState(data.origin_state ?? '');
        setOriginPostalCode(data.origin_postal_code ?? '');
        setResolvedLabel(data.origin_resolved_label ?? null);

        const settings = data.settings ?? {};
        setFixedPrice(settings.fixed_price != null ? String(settings.fixed_price) : '0');
        setNeighborhoods(
          (settings.neighborhoods ?? []).map((n: { id: string; name: string; price: number }) => ({
            id: n.id,
            name: n.name,
            price: String(n.price),
          })),
        );
        setRanges(
          (settings.rules ?? []).map((r: { from: number; to: number; price: number }) => ({
            from: String(r.from),
            to: String(r.to),
            price: String(r.price),
          })),
        );
        setBasePrice(settings.base_price != null ? String(settings.base_price) : '0');
        setPricePerKm(settings.price_per_km != null ? String(settings.price_per_km) : '0');
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

  const addNeighborhood = () => {
    setNeighborhoods((prev) => [...prev, { id: crypto.randomUUID(), name: '', price: '0' }]);
  };
  const updateNeighborhood = (id: string, field: 'name' | 'price', value: string) => {
    setNeighborhoods((prev) => prev.map((n) => (n.id === id ? { ...n, [field]: value } : n)));
  };
  const removeNeighborhood = (id: string) => {
    setNeighborhoods((prev) => prev.filter((n) => n.id !== id));
  };

  const addRange = () => {
    setRanges((prev) => [...prev, { from: '0', to: '0', price: '0' }]);
  };
  const updateRange = (idx: number, field: keyof RangeRow, value: string) => {
    setRanges((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r)));
  };
  const removeRange = (idx: number) => {
    setRanges((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      let settings: Record<string, unknown>;
      switch (method) {
        case 'fixed':
          settings = { fixed_price: Number(fixedPrice) || 0 };
          break;
        case 'neighborhood':
          settings = {
            neighborhoods: neighborhoods.map((n) => ({
              id: n.id,
              name: n.name.trim(),
              price: Number(n.price) || 0,
            })),
          };
          break;
        case 'distance_range':
          settings = {
            rules: ranges.map((r) => ({
              from: Number(r.from) || 0,
              to: Number(r.to) || 0,
              price: Number(r.price) || 0,
            })),
          };
          break;
        case 'per_km':
          settings = { base_price: Number(basePrice) || 0, price_per_km: Number(pricePerKm) || 0 };
          break;
      }

      const res = await fetch('/api/delivery/fee-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          delivery_method: method,
          max_distance: maxDistance.trim() ? Number(maxDistance) : null,
          free_shipping_above: freeShippingAbove.trim() ? Number(freeShippingAbove) : null,
          origin_street: originStreet.trim() || null,
          origin_neighbourhood: originNeighbourhood.trim() || null,
          origin_city: originCity.trim() || null,
          origin_state: originState.trim() || null,
          origin_postal_code: originPostalCode.trim() || null,
          settings,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(t('saveSuccess'));
        if (data.geocodeWarning) toast.warning(data.geocodeWarning);
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
              <Truck className="h-4 w-4 text-primary" /> {t('globalSettingsTitle')}
            </CardTitle>
            <CardDescription>{t('globalSettingsDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">{t('originAddressLabel')}</p>
                <p className="text-xs text-muted-foreground">{t('originAddressHelp')}</p>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="space-y-1.5 sm:col-span-2">
                  <label className="text-xs text-muted-foreground">{t('originStreetLabel')}</label>
                  <Input
                    value={originStreet}
                    onChange={(e) => setOriginStreet(e.target.value)}
                    disabled={disabled}
                    placeholder={t('originStreetPlaceholder')}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground">{t('originNeighbourhoodLabel')}</label>
                  <Input
                    value={originNeighbourhood}
                    onChange={(e) => setOriginNeighbourhood(e.target.value)}
                    disabled={disabled}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="space-y-1.5 sm:col-span-1">
                  <label className="text-xs text-muted-foreground">{t('originCityLabel')}</label>
                  <Input
                    value={originCity}
                    onChange={(e) => setOriginCity(e.target.value)}
                    disabled={disabled}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground">{t('originStateLabel')}</label>
                  <Select value={originState} onValueChange={(v) => setOriginState(v ?? '')} disabled={disabled}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder={t('originStatePlaceholder')} />
                    </SelectTrigger>
                    <SelectContent>
                      {BR_STATES.map(([uf, name]) => (
                        <SelectItem key={uf} value={uf}>
                          {uf} — {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground">{t('originPostalCodeLabel')}</label>
                  <Input
                    value={originPostalCode}
                    onChange={(e) => setOriginPostalCode(e.target.value)}
                    disabled={disabled}
                    placeholder="00000-000"
                  />
                </div>
              </div>

              {resolvedLabel && (
                <p className="rounded-md bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-500">
                  {t('originResolvedTo', { label: resolvedLabel })}
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">{t('maxDistanceLabel')}</label>
                <Input
                  type="number"
                  min="0"
                  step="0.1"
                  value={maxDistance}
                  onChange={(e) => setMaxDistance(e.target.value)}
                  disabled={disabled}
                  placeholder={t('maxDistancePlaceholder')}
                />
                <p className="text-xs text-muted-foreground">{t('maxDistanceHelp')}</p>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">{t('freeShippingLabel')}</label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={freeShippingAbove}
                  onChange={(e) => setFreeShippingAbove(e.target.value)}
                  disabled={disabled}
                  placeholder={t('freeShippingPlaceholder')}
                />
                <p className="text-xs text-muted-foreground">{t('freeShippingHelp')}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('methodTitle')}</CardTitle>
            <CardDescription>{t('methodDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">{t('methodLabel')}</label>
              <Select value={method} onValueChange={(v) => setMethod(v as DeliveryMethod)} disabled={disabled}>
                <SelectTrigger className="w-full sm:w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {METHODS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {t(`method.${m}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {method === 'fixed' && (
              <div className="space-y-1.5 sm:w-72">
                <label className="text-sm font-medium text-foreground">{t('fixedPriceLabel')}</label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={fixedPrice}
                  onChange={(e) => setFixedPrice(e.target.value)}
                  disabled={disabled}
                />
              </div>
            )}

            {method === 'neighborhood' && (
              <div className="space-y-2">
                {neighborhoods.length === 0 && (
                  <p className="text-sm text-muted-foreground">{t('noNeighborhoods')}</p>
                )}
                {neighborhoods.map((n) => (
                  <div key={n.id} className="flex items-center gap-2">
                    <Input
                      value={n.name}
                      onChange={(e) => updateNeighborhood(n.id, 'name', e.target.value)}
                      disabled={disabled}
                      placeholder={t('neighborhoodNamePlaceholder')}
                      className="flex-1"
                    />
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={n.price}
                      onChange={(e) => updateNeighborhood(n.id, 'price', e.target.value)}
                      disabled={disabled}
                      className="w-28"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeNeighborhood(n.id)}
                      disabled={disabled}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm" onClick={addNeighborhood} disabled={disabled}>
                  <Plus className="mr-1 h-4 w-4" /> {t('addNeighborhood')}
                </Button>
              </div>
            )}

            {method === 'distance_range' && (
              <div className="space-y-2">
                {ranges.length === 0 && <p className="text-sm text-muted-foreground">{t('noRanges')}</p>}
                {ranges.map((r, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <Input
                      type="number"
                      min="0"
                      step="0.1"
                      value={r.from}
                      onChange={(e) => updateRange(idx, 'from', e.target.value)}
                      disabled={disabled}
                      placeholder={t('rangeFromPlaceholder')}
                      className="w-24"
                    />
                    <span className="text-muted-foreground">–</span>
                    <Input
                      type="number"
                      min="0"
                      step="0.1"
                      value={r.to}
                      onChange={(e) => updateRange(idx, 'to', e.target.value)}
                      disabled={disabled}
                      placeholder={t('rangeToPlaceholder')}
                      className="w-24"
                    />
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={r.price}
                      onChange={(e) => updateRange(idx, 'price', e.target.value)}
                      disabled={disabled}
                      placeholder={t('rangePricePlaceholder')}
                      className="w-28"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeRange(idx)}
                      disabled={disabled}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm" onClick={addRange} disabled={disabled}>
                  <Plus className="mr-1 h-4 w-4" /> {t('addRange')}
                </Button>
              </div>
            )}

            {method === 'per_km' && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:w-72">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-foreground">{t('basePriceLabel')}</label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={basePrice}
                    onChange={(e) => setBasePrice(e.target.value)}
                    disabled={disabled}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-foreground">{t('pricePerKmLabel')}</label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={pricePerKm}
                    onChange={(e) => setPricePerKm(e.target.value)}
                    disabled={disabled}
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Route className="h-4 w-4 text-primary" /> {t('simulator.title')}
            </CardTitle>
            <CardDescription>{t('simulator.description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">
                  {t('simulator.addressLabel')}
                </label>
                <Input
                  value={simAddress}
                  onChange={(e) => setSimAddress(e.target.value)}
                  placeholder={t('simulator.addressPlaceholder')}
                />
              </div>
              <div className="space-y-1.5 sm:w-40">
                <label className="text-sm font-medium text-foreground">
                  {t('simulator.subtotalLabel')}
                </label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={simSubtotal}
                  onChange={(e) => setSimSubtotal(e.target.value)}
                  placeholder="0,00"
                />
              </div>
            </div>

            <Button
              type="button"
              variant="outline"
              onClick={runSimulation}
              disabled={simulating || loading}
            >
              {simulating ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <MapPin className="mr-2 h-4 w-4" />
              )}
              {simulating ? t('simulator.simulating') : t('simulator.simulate')}
            </Button>

            {simResult && (
              <div
                className={
                  simResult.ok
                    ? 'space-y-1 rounded-md bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-500'
                    : 'rounded-md bg-destructive/10 px-3 py-2.5 text-sm text-destructive'
                }
              >
                {simResult.ok ? (
                  <>
                    {simResult.distanceKm != null && (
                      <p>{t('simulator.resultDistance', { km: simResult.distanceKm.toFixed(1) })}</p>
                    )}
                    <p className="font-semibold">
                      {simResult.freeShipping
                        ? t('simulator.resultFreeShipping')
                        : t('simulator.resultFee', { fee: formatFee(simResult.fee) })}
                    </p>
                  </>
                ) : (
                  <p>{t(`simulator.reason.${simResult.reason}`)}</p>
                )}
              </div>
            )}
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
