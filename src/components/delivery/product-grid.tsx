"use client";

import type { DeliveryProduct } from "@/types";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { formatCurrency } from "@/lib/currency";
import { ImageIcon, Pencil, Plus, UtensilsCrossed } from "lucide-react";
import { useTranslations } from "next-intl";

interface ProductGridProps {
  products: DeliveryProduct[];
  onAddProduct: () => void;
  onEditProduct: (product: DeliveryProduct) => void;
  onToggled: () => void;
}

export function ProductGrid({ products, onAddProduct, onEditProduct, onToggled }: ProductGridProps) {
  const t = useTranslations("Delivery.productGrid");
  const { defaultCurrency } = useAuth();
  const canEdit = useCan("edit-settings");
  const supabase = createClient();

  async function handleToggleActive(product: DeliveryProduct) {
    await supabase
      .from("delivery_products")
      .update({ is_active: !product.is_active })
      .eq("id", product.id);
    onToggled();
  }

  if (products.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-border py-20">
        <UtensilsCrossed className="h-12 w-12 text-muted-foreground" />
        <h3 className="mt-4 text-lg font-medium text-foreground">{t("noProducts")}</h3>
        <p className="mt-2 text-sm text-muted-foreground">{t("noProductsDesc")}</p>
        {canEdit && (
          <Button
            onClick={onAddProduct}
            className="mt-4 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="mr-1 h-4 w-4" />
            {t("addProduct")}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {canEdit && (
        <button
          type="button"
          onClick={onAddProduct}
          className="flex min-h-[128px] flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
        >
          <Plus className="h-5 w-5" />
          {t("addProduct")}
        </button>
      )}
      {products.map((product) => (
        <div
          key={product.id}
          className="flex gap-3 rounded-xl border border-border bg-card p-3"
        >
          <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
            {product.image_url ? (
              // eslint-disable-next-line @next/next/no-img-element -- remote Supabase Storage URL, not configured in next.config image domains
              <img src={product.image_url} alt="" className="h-full w-full object-cover" />
            ) : (
              <ImageIcon className="h-5 w-5 text-muted-foreground" />
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-col justify-between">
            <div>
              <p className="truncate text-sm font-medium text-foreground">{product.name}</p>
              <p className="text-sm font-semibold text-primary">
                {formatCurrency(product.price, defaultCurrency)}
              </p>
            </div>
            <div className="flex items-center justify-between gap-2">
              <Switch
                checked={product.is_active}
                onCheckedChange={() => handleToggleActive(product)}
                disabled={!canEdit}
              />
              {canEdit && (
                <button
                  type="button"
                  onClick={() => onEditProduct(product)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
