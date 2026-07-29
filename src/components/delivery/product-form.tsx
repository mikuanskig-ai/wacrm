"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { uploadAccountMedia } from "@/lib/storage/upload-media";
import type { DeliveryCategory, DeliveryProduct } from "@/types";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { AddonGroupEditor } from "./addon-group-editor";
import { ImageIcon, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

interface ProductFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product?: DeliveryProduct | null;
  categories: DeliveryCategory[];
  defaultCategoryId?: string | null;
  onSaved: () => void;
}

export function ProductForm({
  open,
  onOpenChange,
  product,
  categories,
  defaultCategoryId,
  onSaved,
}: ProductFormProps) {
  const t = useTranslations("Delivery.productForm");
  const supabase = createClient();
  const { accountId } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [isActive, setIsActive] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // The product needs to exist before addon groups/options can reference
  // it via product_id, so a brand-new product is created (as a draft
  // with the fields filled so far) the first time the user opens the
  // addon editor, rather than gating the whole form behind a first save.
  const [createdDraft, setCreatedDraft] = useState<DeliveryProduct | null>(null);

  useEffect(() => {
    if (!open) return;
    setConfirmDelete(false);
    setCreatedDraft(null);
    if (product) {
      setName(product.name);
      setDescription(product.description ?? "");
      setPrice(String(product.price));
      setCategoryId(product.category_id ?? "");
      setImageUrl(product.image_url ?? null);
      setIsActive(product.is_active);
    } else {
      setName("");
      setDescription("");
      setPrice("");
      setCategoryId(defaultCategoryId ?? "");
      setImageUrl(null);
      setIsActive(true);
    }
  }, [open, product, defaultCategoryId]);

  const activeProduct = product ?? createdDraft;

  async function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const { publicUrl } = await uploadAccountMedia("delivery-media", file);
      setImageUrl(publicUrl);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("toastFailedUpload"));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function buildPayload() {
    return {
      name: name.trim(),
      description: description.trim() || null,
      price: parseFloat(price) || 0,
      category_id: categoryId || null,
      image_url: imageUrl,
      is_active: isActive,
    };
  }

  async function handleSave() {
    if (!name.trim()) {
      toast.error(t("toastRequired"));
      return;
    }
    setSaving(true);

    if (activeProduct) {
      const { error } = await supabase
        .from("delivery_products")
        .update(buildPayload())
        .eq("id", activeProduct.id);
      setSaving(false);
      if (error) {
        toast.error(t("toastFailedSave"));
        return;
      }
    } else {
      if (!accountId) {
        toast.error(t("toastNotLinked"));
        setSaving(false);
        return;
      }
      const { error } = await supabase.from("delivery_products").insert({
        ...buildPayload(),
        account_id: accountId,
        position: 0,
      });
      setSaving(false);
      if (error) {
        toast.error(t("toastFailedCreate"));
        return;
      }
    }

    onOpenChange(false);
    onSaved();
    toast.success(activeProduct ? t("toastUpdated") : t("toastCreated"));
  }

  async function handleEnableAddons() {
    if (!accountId || !name.trim()) {
      toast.error(t("toastRequired"));
      return;
    }
    const { data, error } = await supabase
      .from("delivery_products")
      .insert({ ...buildPayload(), account_id: accountId, position: 0 })
      .select()
      .single();
    if (error || !data) {
      toast.error(t("toastFailedCreate"));
      return;
    }
    setCreatedDraft(data as DeliveryProduct);
    onSaved();
  }

  async function handleDelete() {
    if (!activeProduct) return;
    setDeleting(true);
    const { error } = await supabase.from("delivery_products").delete().eq("id", activeProduct.id);
    setDeleting(false);
    if (error) {
      toast.error(t("toastFailedDelete"));
      return;
    }
    toast.success(t("toastDeleted"));
    setConfirmDelete(false);
    onOpenChange(false);
    onSaved();
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="bg-popover border-border text-popover-foreground sm:max-w-lg w-full p-0"
      >
        <div className="flex h-full flex-col">
          <SheetHeader className="border-b border-border/50 p-4">
            <SheetTitle className="text-popover-foreground">
              {product ? t("editProduct") : t("newProduct")}
            </SheetTitle>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("photo")}</Label>
              <div className="flex items-center gap-3">
                <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
                  {imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- remote Supabase Storage URL, not configured in next.config image domains
                    <img src={imageUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <ImageIcon className="h-6 w-6 text-muted-foreground" />
                  )}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={handleImageChange}
                  className="hidden"
                  id="product-image-input"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="border-border bg-transparent text-muted-foreground hover:bg-muted"
                >
                  {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t("uploadPhoto")}
                </Button>
              </div>
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("name")}</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("namePlaceholder")}
                className="border-border bg-muted text-foreground"
              />
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("description")}</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t("descriptionPlaceholder")}
                className="min-h-[80px] border-border bg-muted text-foreground"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label className="text-muted-foreground">{t("price")}</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="0.00"
                  className="border-border bg-muted text-foreground"
                />
              </div>
              <div className="grid gap-2">
                <Label className="text-muted-foreground">{t("category")}</Label>
                <select
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                  className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
                >
                  <option value="">{t("noCategory")}</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3">
              <Label className="text-foreground">{t("active")}</Label>
              <Switch checked={isActive} onCheckedChange={setIsActive} />
            </div>

            <div className="grid gap-2 border-t border-border/50 pt-4">
              <Label className="text-muted-foreground">{t("addonGroups")}</Label>
              {activeProduct ? (
                <AddonGroupEditor productId={activeProduct.id} />
              ) : (
                <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
                  {t("addonsNeedSaveHint")}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleEnableAddons}
                    disabled={!name.trim()}
                    className="mt-2 w-full border-border bg-transparent text-muted-foreground hover:bg-muted"
                  >
                    {t("saveAndAddAddons")}
                  </Button>
                </div>
              )}
            </div>
          </div>

          <div className="border-t border-border/50 bg-popover/80 p-4">
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="flex-1 border-border bg-transparent text-muted-foreground hover:bg-muted"
              >
                {t("cancel")}
              </Button>
              <Button
                onClick={handleSave}
                disabled={saving || !name.trim()}
                className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {saving ? t("saving") : activeProduct ? t("saveChanges") : t("createProduct")}
              </Button>
            </div>

            {activeProduct &&
              (confirmDelete ? (
                <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs">
                  <span className="text-red-300">{t("deletePrompt")}</span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      disabled={deleting}
                      className="rounded px-2 py-1 text-muted-foreground hover:bg-muted"
                    >
                      {t("cancel")}
                    </button>
                    <button
                      type="button"
                      onClick={handleDelete}
                      disabled={deleting}
                      className="rounded bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      {deleting ? t("deleting") : t("confirm")}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="mt-3 flex w-full items-center justify-center gap-1 text-xs text-red-400 hover:text-red-300"
                >
                  <Trash2 className="h-3 w-3" />
                  {t("deleteProduct")}
                </button>
              ))}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
