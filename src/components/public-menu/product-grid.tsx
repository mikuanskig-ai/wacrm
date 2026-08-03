'use client';

import { useTranslations } from 'next-intl';
import { formatCurrency } from '@/lib/currency';
import { Button } from '@/components/ui/button';
import type { PublicCategory, PublicProduct } from './types';

// Browsing and adding to cart stay enabled even when the store is
// currently closed (business hours only gate the final checkout step
// — see PublicMenuCheckoutForm) so a customer can plan ahead.
function ProductCard({
  product,
  currency,
  onSelect,
}: {
  product: PublicProduct;
  currency: string;
  onSelect: (product: PublicProduct) => void;
}) {
  const t = useTranslations('PublicMenu');
  return (
    <button
      type="button"
      onClick={() => onSelect(product)}
      className="flex w-full items-start gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-primary/40"
    >
      {product.image_url && (
        // eslint-disable-next-line @next/next/no-img-element -- external merchant-hosted URLs, no next/image domain config for arbitrary hosts
        <img
          src={product.image_url}
          alt={product.name}
          className="h-16 w-16 shrink-0 rounded-md object-cover"
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{product.name}</p>
        {product.description && (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{product.description}</p>
        )}
        <p className="mt-1 text-sm font-semibold text-primary">
          {formatCurrency(product.price, currency)}
        </p>
      </div>
      <Button size="sm" variant="outline" className="shrink-0" tabIndex={-1}>
        {t('addToCart')}
      </Button>
    </button>
  );
}

export function PublicMenuProductGrid({
  categories,
  uncategorizedProducts,
  currency,
  onSelectProduct,
}: {
  categories: PublicCategory[];
  uncategorizedProducts: PublicProduct[];
  currency: string;
  onSelectProduct: (product: PublicProduct) => void;
}) {
  const t = useTranslations('PublicMenu');
  const hasAnyProduct =
    categories.some((c) => c.products.length > 0) || uncategorizedProducts.length > 0;

  if (!hasAnyProduct) {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">{t('emptyMenu')}</p>
    );
  }

  return (
    <div className="space-y-8">
      {categories
        .filter((c) => c.products.length > 0)
        .map((category) => (
          <section key={category.id} id={`category-${category.id}`}>
            <h2 className="mb-3 text-base font-semibold text-foreground">{category.name}</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {category.products.map((product) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  currency={currency}
                  onSelect={onSelectProduct}
                />
              ))}
            </div>
          </section>
        ))}
      {uncategorizedProducts.length > 0 && (
        <section>
          <h2 className="mb-3 text-base font-semibold text-foreground">{t('otherCategory')}</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {uncategorizedProducts.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                currency={currency}
                onSelect={onSelectProduct}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
