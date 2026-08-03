"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { hasModule } from "@/lib/accounts/modules";
import type { DeliveryCategory, DeliveryProduct } from "@/types";
import { CategoryList } from "@/components/delivery/category-list";
import { CategoryFormDialog } from "@/components/delivery/category-form-dialog";
import { ProductGrid } from "@/components/delivery/product-grid";
import { ProductForm } from "@/components/delivery/product-form";
import { Button } from "@/components/ui/button";
import { ArrowLeft, UtensilsCrossed, LayoutGrid } from "lucide-react";
import { useTranslations } from "next-intl";

export default function DeliveryMenuPage() {
  const t = useTranslations("Delivery.page");
  const supabase = createClient();
  const { account, profileLoading } = useAuth();

  const [categories, setCategories] = useState<DeliveryCategory[]>([]);
  const [products, setProducts] = useState<DeliveryProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);

  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<DeliveryCategory | null>(null);
  const [productFormOpen, setProductFormOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<DeliveryProduct | null>(null);

  const moduleEnabled = hasModule(account, "delivery");

  const loadAll = useCallback(async () => {
    const [{ data: cats }, { data: prods }] = await Promise.all([
      supabase.from("delivery_categories").select("*").order("position"),
      supabase.from("delivery_products").select("*").order("position"),
    ]);
    setCategories((cats ?? []) as DeliveryCategory[]);
    setProducts((prods ?? []) as DeliveryProduct[]);
  }, [supabase]);

  useEffect(() => {
    if (profileLoading || !moduleEnabled) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kicks off the async load, settled inside the .finally callback
    setLoading(true);
    loadAll().finally(() => setLoading(false));
  }, [profileLoading, moduleEnabled, loadAll]);

  if (profileLoading) {
    return <div className="h-8 w-48 animate-pulse rounded bg-muted" />;
  }

  if (!moduleEnabled) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-20">
        <UtensilsCrossed className="h-12 w-12 text-muted-foreground" />
        <h3 className="mt-4 text-lg font-medium text-foreground">{t("moduleOffTitle")}</h3>
        <p className="mt-2 max-w-sm text-center text-sm text-muted-foreground">
          {t("moduleOffDesc")}
        </p>
        <Button
          render={<Link href="/settings?tab=modules" />}
          className="mt-4 bg-primary text-primary-foreground hover:bg-primary/90"
        >
          {t("goToSettings")}
        </Button>
      </div>
    );
  }

  const visibleProducts = selectedCategoryId
    ? products.filter((p) => p.category_id === selectedCategoryId)
    : products;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button
            render={<Link href="/delivery/pedidos" />}
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-xl font-semibold text-foreground">{t("title")}</h1>
            <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            render={<Link href="/delivery/operacao" />}
            variant="outline"
            className="border-border bg-card text-foreground hover:bg-muted"
          >
            <LayoutGrid className="mr-1.5 h-4 w-4" />
            {t("viewOperations")}
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex gap-4">
          <div className="h-64 w-56 animate-pulse rounded-xl bg-muted/50" />
          <div className="grid flex-1 grid-cols-3 gap-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-32 animate-pulse rounded-xl bg-muted/50" />
            ))}
          </div>
        </div>
      ) : (
        <div className="flex gap-4">
          <CategoryList
            categories={categories}
            selectedCategoryId={selectedCategoryId}
            onSelectCategory={setSelectedCategoryId}
            onAddCategory={() => {
              setEditingCategory(null);
              setCategoryDialogOpen(true);
            }}
            onEditCategory={(c) => {
              setEditingCategory(c);
              setCategoryDialogOpen(true);
            }}
            onReordered={loadAll}
          />
          <ProductGrid
            products={visibleProducts}
            onAddProduct={() => {
              setEditingProduct(null);
              setProductFormOpen(true);
            }}
            onEditProduct={(p) => {
              setEditingProduct(p);
              setProductFormOpen(true);
            }}
            onToggled={loadAll}
          />
        </div>
      )}

      <CategoryFormDialog
        open={categoryDialogOpen}
        onOpenChange={setCategoryDialogOpen}
        category={editingCategory}
        nextPosition={categories.length}
        onSaved={loadAll}
      />

      <ProductForm
        open={productFormOpen}
        onOpenChange={setProductFormOpen}
        product={editingProduct}
        categories={categories}
        defaultCategoryId={selectedCategoryId}
        onSaved={loadAll}
      />
    </div>
  );
}
