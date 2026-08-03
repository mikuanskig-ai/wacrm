'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Minus, Plus, Trash2 } from 'lucide-react';
import { formatCurrency } from '@/lib/currency';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from '@/components/ui/sheet';
import { cartLineTotal, cartTotal, type CartEntry } from './types';

export interface CheckoutFormValues {
  customer_name: string;
  customer_phone: string;
  delivery_address: string;
  notes: string;
}

export type DeliveryFeeReason =
  | 'address_required'
  | 'origin_not_configured'
  | 'geocode_failed'
  | 'out_of_range'
  | 'neighborhood_not_found'
  | 'no_matching_distance_range';

interface DeliveryFeeState {
  loading: boolean;
  fee: number | null;
  freeShipping: boolean;
  reason: DeliveryFeeReason | null;
}

export const DELIVERY_FEE_REASON_KEY: Record<DeliveryFeeReason, string> = {
  address_required: 'addressRequired',
  origin_not_configured: 'originNotConfigured',
  geocode_failed: 'geocodeFailed',
  out_of_range: 'outOfRange',
  neighborhood_not_found: 'neighborhoodNotFound',
  no_matching_distance_range: 'noMatchingDistanceRange',
};

export function PublicMenuCartDrawer({
  open,
  onOpenChange,
  slug,
  cart,
  currency,
  storeOpen,
  submitting,
  onUpdateQuantity,
  onRemove,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
  cart: CartEntry[];
  currency: string;
  storeOpen: boolean;
  submitting: boolean;
  onUpdateQuantity: (key: string, quantity: number) => void;
  onRemove: (key: string) => void;
  onSubmit: (values: CheckoutFormValues) => void;
}) {
  const t = useTranslations('PublicMenu');
  const [checkoutView, setCheckoutView] = useState(false);
  const [form, setForm] = useState<CheckoutFormValues>({
    customer_name: '',
    customer_phone: '',
    delivery_address: '',
    notes: '',
  });
  const [deliveryFee, setDeliveryFee] = useState<DeliveryFeeState>({
    loading: false,
    fee: null,
    freeShipping: false,
    reason: null,
  });

  const total = cartTotal(cart);
  const canCheckout =
    cart.length > 0 && storeOpen && (!checkoutView || deliveryFee.fee !== null);

  // Always asks the server, even with an empty address: most accounts
  // use a flat/no-address method that doesn't need one at all, and
  // only the engine (via delivery_fee_configs) knows whether this
  // particular tenant requires it — the client never assumes.
  const checkDeliveryFee = async () => {
    const address = form.delivery_address.trim();
    setDeliveryFee((prev) => ({ ...prev, loading: true, reason: null }));
    try {
      const res = await fetch(`/api/public/menu/${slug}/delivery-fee`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: address || undefined, subtotal: total }),
      });
      const data = await res.json();
      if (data.ok) {
        setDeliveryFee({ loading: false, fee: data.fee, freeShipping: data.freeShipping, reason: null });
      } else {
        setDeliveryFee({ loading: false, fee: null, freeShipping: false, reason: data.reason });
      }
    } catch {
      setDeliveryFee({ loading: false, fee: null, freeShipping: false, reason: 'geocode_failed' });
    }
  };

  // Runs once as the checkout step opens, using whatever address is
  // already in the field (often empty) — covers the common flat-fee
  // account that needs no address at all, so submit isn't blocked
  // just because the customer never touched that field.
  useEffect(() => {
    if (checkoutView) void checkDeliveryFee();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkoutView]);

  const handleOpenChange = (next: boolean) => {
    if (!next) setCheckoutView(false);
    onOpenChange(next);
  };

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-sm">
        <SheetHeader>
          <SheetTitle>{checkoutView ? t('checkout.submit') : t('cart.title')}</SheetTitle>
        </SheetHeader>

        {!checkoutView ? (
          <>
            <div className="flex-1 space-y-3 overflow-y-auto px-4">
              {cart.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">{t('cart.empty')}</p>
              ) : (
                cart.map((entry) => (
                  <div key={entry.key} className="rounded-md border border-border p-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">
                          {entry.product_name}
                        </p>
                        {entry.addons.length > 0 && (
                          <p className="text-xs text-muted-foreground">
                            {entry.addons.map((a) => a.option_name).join(', ')}
                          </p>
                        )}
                        {entry.notes && (
                          <p className="text-xs text-muted-foreground">{entry.notes}</p>
                        )}
                      </div>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        onClick={() => onRemove(entry.key)}
                        aria-label={t('cart.remove')}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Button
                          size="icon-xs"
                          variant="outline"
                          onClick={() => onUpdateQuantity(entry.key, entry.quantity - 1)}
                        >
                          <Minus className="h-3 w-3" />
                        </Button>
                        <span className="w-5 text-center text-sm">{entry.quantity}</span>
                        <Button
                          size="icon-xs"
                          variant="outline"
                          onClick={() => onUpdateQuantity(entry.key, entry.quantity + 1)}
                        >
                          <Plus className="h-3 w-3" />
                        </Button>
                      </div>
                      <span className="text-sm font-medium text-foreground">
                        {formatCurrency(cartLineTotal(entry), currency)}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>

            <SheetFooter>
              {!storeOpen && cart.length > 0 && (
                <p className="text-center text-xs text-amber-500">{t('errors.closed')}</p>
              )}
              <div className="flex items-center justify-between text-sm font-medium text-foreground">
                <span>{t('cart.subtotal')}</span>
                <span>{formatCurrency(total, currency)}</span>
              </div>
              <Button
                onClick={() => setCheckoutView(true)}
                disabled={!canCheckout}
                className="w-full"
              >
                {t('cart.checkout')}
              </Button>
            </SheetFooter>
          </>
        ) : (
          <>
            <div className="flex-1 space-y-3 overflow-y-auto px-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">{t('checkout.name')}</label>
                <Input
                  value={form.customer_name}
                  onChange={(e) => setForm((f) => ({ ...f, customer_name: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">{t('checkout.phone')}</label>
                <Input
                  value={form.customer_phone}
                  onChange={(e) => setForm((f) => ({ ...f, customer_phone: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">{t('checkout.address')}</label>
                <Input
                  value={form.delivery_address}
                  onChange={(e) => {
                    setForm((f) => ({ ...f, delivery_address: e.target.value }));
                    setDeliveryFee({ loading: false, fee: null, freeShipping: false, reason: null });
                  }}
                  onBlur={checkDeliveryFee}
                />
                {deliveryFee.loading && (
                  <p className="text-xs text-muted-foreground">{t('deliveryFee.calculating')}</p>
                )}
                {!deliveryFee.loading && deliveryFee.reason && (
                  <p className="text-xs text-destructive">
                    {t(`deliveryFee.${DELIVERY_FEE_REASON_KEY[deliveryFee.reason]}`)}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">{t('checkout.notes')}</label>
                <Textarea
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  rows={2}
                />
              </div>
            </div>
            <SheetFooter>
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>{t('cart.subtotal')}</span>
                <span>{formatCurrency(total, currency)}</span>
              </div>
              {deliveryFee.fee !== null && (
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>{t('deliveryFee.label')}</span>
                  <span>
                    {deliveryFee.freeShipping ? t('deliveryFee.freeShipping') : formatCurrency(deliveryFee.fee, currency)}
                  </span>
                </div>
              )}
              <div className="flex items-center justify-between text-sm font-medium text-foreground">
                <span>{deliveryFee.fee !== null ? t('deliveryFee.total') : t('cart.subtotal')}</span>
                <span>{formatCurrency(total + (deliveryFee.fee ?? 0), currency)}</span>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => setCheckoutView(false)}
                  disabled={submitting}
                  className="flex-1"
                >
                  {t('cart.title')}
                </Button>
                <Button
                  onClick={() => onSubmit(form)}
                  disabled={submitting || deliveryFee.fee === null}
                  className="flex-1"
                >
                  {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  {submitting ? t('checkout.submitting') : t('checkout.submit')}
                </Button>
              </div>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
