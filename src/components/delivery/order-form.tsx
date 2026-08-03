"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { formatCurrency } from "@/lib/currency";
import type {
  Contact,
  DeliveryAddonGroup,
  DeliveryAddonOption,
  DeliveryProduct,
} from "@/types";
import type { CartLineItem, CartLineItemAddon } from "@/lib/delivery/create-order";
import { effectivePrice } from "@/lib/delivery/day-price";
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
import { Trash2, Plus, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

interface OrderFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

type ProductWithAddons = DeliveryProduct & {
  addon_groups: (DeliveryAddonGroup & { options: DeliveryAddonOption[] })[];
};

export function OrderForm({ open, onOpenChange, onSaved }: OrderFormProps) {
  const t = useTranslations("Delivery.orderForm");
  const supabase = createClient();
  const { accountId, defaultCurrency } = useAuth();

  const [contactMode, setContactMode] = useState<"existing" | "new">("existing");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactId, setContactId] = useState("");
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");

  const [products, setProducts] = useState<ProductWithAddons[]>([]);
  const [pickedProductId, setPickedProductId] = useState("");
  const [pickedOptions, setPickedOptions] = useState<Record<string, string[]>>({});
  const [pickedQuantity, setPickedQuantity] = useState(1);

  const [cart, setCart] = useState<CartLineItem[]>([]);
  const [deliveryFee, setDeliveryFee] = useState("");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [calculatingFee, setCalculatingFee] = useState(false);

  useEffect(() => {
    if (!open) return;
    setContactMode("existing");
    setContactId("");
    setNewName("");
    setNewPhone("");
    setPickedProductId("");
    setPickedOptions({});
    setPickedQuantity(1);
    setCart([]);
    setDeliveryFee("");
    setDeliveryAddress("");
    setNotes("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const [{ data: contactRows }, { data: productRows }, { data: groupRows }] =
        await Promise.all([
          supabase.from("contacts").select("*").order("name"),
          supabase.from("delivery_products").select("*").eq("is_active", true).order("position"),
          supabase.from("delivery_addon_groups").select("*, options:delivery_addon_options(*)").order("position"),
        ]);
      if (cancelled) return;
      setContacts((contactRows ?? []) as Contact[]);
      const groups = (groupRows ?? []) as (DeliveryAddonGroup & { options: DeliveryAddonOption[] })[];
      setProducts(
        ((productRows ?? []) as DeliveryProduct[]).map((p) => ({
          ...p,
          // Staff creating a manual order (phone/counter) should be
          // charging today's actual price, same as a self-service order.
          price: effectivePrice(p.price, p.day_price_overrides),
          addon_groups: groups.filter((g) => g.product_id === p.id),
        })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [open, supabase]);

  const pickedProduct = products.find((p) => p.id === pickedProductId) ?? null;

  const pickedLineTotal = useMemo(() => {
    if (!pickedProduct) return 0;
    const addonsTotal = pickedProduct.addon_groups.reduce((sum, g) => {
      const selected = pickedOptions[g.id] ?? [];
      return (
        sum +
        (g.options ?? [])
          .filter((o) => selected.includes(o.id))
          .reduce((s, o) => s + o.price_delta, 0)
      );
    }, 0);
    return (pickedProduct.price + addonsTotal) * pickedQuantity;
  }, [pickedProduct, pickedOptions, pickedQuantity]);

  const cartTotal = useMemo(() => {
    return cart.reduce((sum, item) => {
      const addonsTotal = item.addons.reduce((s, a) => s + a.price_delta, 0);
      return sum + (item.unit_price + addonsTotal) * item.quantity;
    }, 0);
  }, [cart]);

  /** Pre-fills deliveryFee from the Motor de Cálculo de Entrega — the
   *  field stays a plain editable input afterward, staff can always
   *  override it (never a hard gate on a manual sale). */
  async function handleCalculateFee() {
    if (!deliveryAddress.trim()) {
      toast.error(t("toastAddressRequiredForCalc"));
      return;
    }
    setCalculatingFee(true);
    try {
      const res = await fetch("/api/delivery/fee/calculate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: deliveryAddress, subtotal: cartTotal }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t("toastCalcFailed"));
        return;
      }
      if (!data.ok) {
        toast.error(t(`toastCalcReason.${data.reason}`));
        return;
      }
      setDeliveryFee(String(data.fee));
      if (data.freeShipping) toast.success(t("toastFreeShipping"));
    } catch {
      toast.error(t("toastCalcFailed"));
    } finally {
      setCalculatingFee(false);
    }
  }

  function toggleOption(group: DeliveryAddonGroup, optionId: string) {
    setPickedOptions((prev) => {
      const current = prev[group.id] ?? [];
      if (group.selection_type === "single") {
        return { ...prev, [group.id]: current.includes(optionId) ? [] : [optionId] };
      }
      return {
        ...prev,
        [group.id]: current.includes(optionId)
          ? current.filter((id) => id !== optionId)
          : [...current, optionId],
      };
    });
  }

  function handleAddToCart() {
    if (!pickedProduct) return;
    for (const group of pickedProduct.addon_groups) {
      if (group.is_required && (pickedOptions[group.id] ?? []).length === 0) {
        toast.error(t("toastRequiredGroup", { name: group.name }));
        return;
      }
    }
    const addons: CartLineItemAddon[] = pickedProduct.addon_groups.flatMap((g) =>
      (pickedOptions[g.id] ?? []).map((optId) => {
        const opt = (g.options ?? []).find((o) => o.id === optId)!;
        return {
          group_id: g.id,
          group_name: g.name,
          option_id: opt.id,
          option_name: opt.name,
          price_delta: opt.price_delta,
        };
      }),
    );
    setCart((prev) => [
      ...prev,
      {
        product_id: pickedProduct.id,
        product_name: pickedProduct.name,
        unit_price: pickedProduct.price,
        quantity: pickedQuantity,
        addons,
      },
    ]);
    setPickedProductId("");
    setPickedOptions({});
    setPickedQuantity(1);
  }

  function handleRemoveCartLine(index: number) {
    setCart((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSave() {
    if (cart.length === 0) {
      toast.error(t("toastCartEmpty"));
      return;
    }
    if (contactMode === "existing" && !contactId) {
      toast.error(t("toastContactRequired"));
      return;
    }
    if (contactMode === "new" && !newPhone.trim()) {
      toast.error(t("toastPhoneRequired"));
      return;
    }
    if (!accountId) return;

    setSaving(true);
    const res = await fetch("/api/delivery/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contact_id: contactMode === "existing" ? contactId : undefined,
        new_contact:
          contactMode === "new" ? { name: newName.trim(), phone: newPhone.trim() } : undefined,
        items: cart,
        delivery_fee: deliveryFee ? parseFloat(deliveryFee) : undefined,
        delivery_address: deliveryAddress.trim() || undefined,
        notes: notes.trim() || undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) {
      toast.error(data?.error ?? t("toastFailedCreate"));
      return;
    }
    toast.success(t("toastCreated"));
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
            <SheetTitle className="text-popover-foreground">{t("newOrder")}</SheetTitle>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("customer")}</Label>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => setContactMode("existing")}
                  className={`flex-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${
                    contactMode === "existing"
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {t("existingContact")}
                </button>
                <button
                  type="button"
                  onClick={() => setContactMode("new")}
                  className={`flex-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${
                    contactMode === "new"
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {t("newContact")}
                </button>
              </div>

              {contactMode === "existing" ? (
                <select
                  value={contactId}
                  onChange={(e) => setContactId(e.target.value)}
                  className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
                >
                  <option value="">{t("selectContact")}</option>
                  {contacts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name || c.phone}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder={t("namePlaceholder")}
                    className="border-border bg-muted text-foreground"
                  />
                  <Input
                    value={newPhone}
                    onChange={(e) => setNewPhone(e.target.value)}
                    placeholder={t("phonePlaceholder")}
                    className="border-border bg-muted text-foreground"
                  />
                </div>
              )}
            </div>

            <div className="grid gap-2 rounded-lg border border-border bg-muted/40 p-3">
              <Label className="text-muted-foreground">{t("addItem")}</Label>
              <select
                value={pickedProductId}
                onChange={(e) => {
                  setPickedProductId(e.target.value);
                  setPickedOptions({});
                }}
                className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
              >
                <option value="">{t("selectProduct")}</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {formatCurrency(p.price, defaultCurrency)}
                  </option>
                ))}
              </select>

              {pickedProduct?.addon_groups.map((group) => (
                <div key={group.id} className="grid gap-1">
                  <p className="text-xs font-medium text-foreground">
                    {group.name}
                    {group.is_required && <span className="text-red-400"> *</span>}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {(group.options ?? []).map((option) => {
                      const selected = (pickedOptions[group.id] ?? []).includes(option.id);
                      return (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() => toggleOption(group, option.id)}
                          className={`rounded-full border px-2 py-0.5 text-xs ${
                            selected
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-border text-muted-foreground hover:bg-muted"
                          }`}
                        >
                          {option.name}
                          {option.price_delta !== 0 &&
                            ` (${option.price_delta > 0 ? "+" : ""}${formatCurrency(option.price_delta, defaultCurrency)})`}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              {pickedProduct && (
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    value={pickedQuantity}
                    onChange={(e) => setPickedQuantity(Math.max(1, Number(e.target.value) || 1))}
                    className="h-8 w-16 border-border bg-muted text-sm text-foreground"
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleAddToCart}
                    className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
                  >
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    {t("addToCart")} · {formatCurrency(pickedLineTotal, defaultCurrency)}
                  </Button>
                </div>
              )}
            </div>

            {cart.length > 0 && (
              <div className="grid gap-1.5">
                <Label className="text-muted-foreground">{t("cart")}</Label>
                {cart.map((item, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 px-2.5 py-1.5 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-foreground">
                        {item.quantity}× {item.product_name}
                      </p>
                      {item.addons.length > 0 && (
                        <p className="truncate text-xs text-muted-foreground">
                          {item.addons.map((a) => a.option_name).join(", ")}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveCartLine(i)}
                      className="shrink-0 text-muted-foreground hover:text-red-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                <p className="text-right text-sm font-semibold text-foreground">
                  {t("subtotal")}: {formatCurrency(cartTotal, defaultCurrency)}
                </p>
              </div>
            )}

            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("deliveryFee")}</Label>
              <div className="flex gap-2">
                <Input
                  type="number"
                  step="0.01"
                  value={deliveryFee}
                  onChange={(e) => setDeliveryFee(e.target.value)}
                  placeholder="0.00"
                  className="border-border bg-muted text-foreground"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleCalculateFee}
                  disabled={calculatingFee}
                  className="shrink-0"
                >
                  {calculatingFee && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                  {t("calculateFee")}
                </Button>
              </div>
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("deliveryAddress")}</Label>
              <Input
                value={deliveryAddress}
                onChange={(e) => setDeliveryAddress(e.target.value)}
                className="border-border bg-muted text-foreground"
              />
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">{t("notes")}</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="min-h-[70px] border-border bg-muted text-foreground"
              />
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
                disabled={saving || cart.length === 0}
                className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t("createOrder")}
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
