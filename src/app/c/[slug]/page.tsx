'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, ShoppingCart, Store } from 'lucide-react';
import { toast } from 'sonner';
import { formatCurrency } from '@/lib/currency';
import { Button } from '@/components/ui/button';
import { PublicMenuHeader } from '@/components/public-menu/menu-header';
import { PublicMenuProductGrid } from '@/components/public-menu/product-grid';
import { PublicMenuProductModal } from '@/components/public-menu/product-modal';
import { PublicMenuCartDrawer, type CheckoutFormValues } from '@/components/public-menu/cart-drawer';
import { loadCart, saveCart, clearCart } from '@/components/public-menu/cart-storage';
import { cartEntryKey, cartTotal, type CartEntry, type PublicMenuResponse, type PublicProduct } from '@/components/public-menu/types';

// Deliberately outside (dashboard), api, and the staff-only delivery/
// tree — a genuinely public, unauthenticated page. Fetches through
// GET /api/public/menu/[slug] (service-role backed) rather than a
// browser Supabase client, since a visitor here has no session for
// RLS to key off of.
export default function PublicMenuPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const t = useTranslations('PublicMenu');

  const [menu, setMenu] = useState<PublicMenuResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [cart, setCart] = useState<CartEntry[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<PublicProduct | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmedOrder, setConfirmedOrder] = useState<{ id: string; total: number } | null>(null);

  useEffect(() => {
    setCart(loadCart(slug));
  }, [slug]);

  const fetchMenu = useCallback(async () => {
    try {
      const res = await fetch(`/api/public/menu/${slug}`);
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      const data = await res.json();
      setMenu(data as PublicMenuResponse);
    } catch {
      toast.error(t('errors.generic'));
    } finally {
      setLoading(false);
    }
  }, [slug, t]);

  useEffect(() => {
    void fetchMenu();
  }, [fetchMenu]);

  const persistCart = (next: CartEntry[]) => {
    setCart(next);
    saveCart(slug, next);
  };

  const handleAddToCart = (
    product: PublicProduct,
    args: { quantity: number; addons: CartEntry['addons']; notes: string | null },
  ) => {
    const key = cartEntryKey(product.id, args.addons.map((a) => a.option_id));
    const existing = cart.find((e) => e.key === key);
    if (existing) {
      persistCart(
        cart.map((e) => (e.key === key ? { ...e, quantity: e.quantity + args.quantity } : e)),
      );
    } else {
      persistCart([
        ...cart,
        {
          key,
          product_id: product.id,
          product_name: product.name,
          unit_price: product.price,
          quantity: args.quantity,
          addons: args.addons,
          notes: args.notes,
        },
      ]);
    }
    setSelectedProduct(null);
    setCartOpen(true);
  };

  const handleUpdateQuantity = (key: string, quantity: number) => {
    if (quantity <= 0) {
      persistCart(cart.filter((e) => e.key !== key));
      return;
    }
    persistCart(cart.map((e) => (e.key === key ? { ...e, quantity } : e)));
  };

  const handleRemove = (key: string) => {
    persistCart(cart.filter((e) => e.key !== key));
  };

  const handleSubmit = async (values: CheckoutFormValues) => {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/public/menu/${slug}/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: cart.map((entry) => ({
            product_id: entry.product_id,
            quantity: entry.quantity,
            addon_option_ids: entry.addons.map((a) => a.option_id),
            notes: entry.notes,
          })),
          customer_name: values.customer_name,
          customer_phone: values.customer_phone,
          delivery_address: values.delivery_address,
          notes: values.notes,
        }),
      });
      const data = await res.json();
      if (res.status === 409) {
        toast.error(data.message ?? t('errors.closed'));
        void fetchMenu();
        return;
      }
      if (!res.ok) {
        toast.error(data.error ?? t('errors.generic'));
        return;
      }

      clearCart(slug);
      if (data.checkout_url) {
        window.location.href = data.checkout_url;
        return;
      }
      persistCart([]);
      setCartOpen(false);
      setConfirmedOrder({ id: data.order_id, total: data.total });
    } catch {
      toast.error(t('errors.generic'));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (notFound || !menu) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2 text-center">
        <Store className="h-8 w-8 text-muted-foreground" />
        <h1 className="text-lg font-semibold text-foreground">{t('notFound.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('notFound.body')}</p>
      </div>
    );
  }

  if (confirmedOrder) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2 px-4 text-center">
        <h1 className="text-lg font-semibold text-foreground">
          {t('checkout.orderConfirmed.title', { id: confirmedOrder.id.slice(0, 8) })}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t('checkout.orderConfirmed.body', {
            total: formatCurrency(confirmedOrder.total, menu.account.currency),
          })}
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-24">
      <PublicMenuHeader
        storeName={menu.account.name}
        open={menu.open}
        closedMessage={menu.closed_message}
      />

      <div className="mx-auto max-w-3xl px-4 py-6">
        <PublicMenuProductGrid
          categories={menu.categories}
          uncategorizedProducts={menu.uncategorized_products}
          currency={menu.account.currency}
          onSelectProduct={setSelectedProduct}
        />
      </div>

      {cart.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 border-t border-border bg-card p-3">
          <div className="mx-auto flex max-w-3xl items-center justify-between">
            <span className="text-sm text-muted-foreground">
              {formatCurrency(cartTotal(cart), menu.account.currency)}
            </span>
            <Button onClick={() => setCartOpen(true)}>
              <ShoppingCart className="mr-1.5 h-4 w-4" />
              {t('cart.title')} ({cart.length})
            </Button>
          </div>
        </div>
      )}

      {selectedProduct && (
        <PublicMenuProductModal
          product={selectedProduct}
          currency={menu.account.currency}
          onClose={() => setSelectedProduct(null)}
          onAdd={(args) => handleAddToCart(selectedProduct, args)}
        />
      )}

      <PublicMenuCartDrawer
        open={cartOpen}
        onOpenChange={setCartOpen}
        cart={cart}
        currency={menu.account.currency}
        storeOpen={menu.open}
        submitting={submitting}
        onUpdateQuantity={handleUpdateQuantity}
        onRemove={handleRemove}
        onSubmit={handleSubmit}
      />
    </div>
  );
}
