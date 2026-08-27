"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { formatCurrency } from "@/lib/currency";
import type { CartLineItem } from "@/lib/delivery/create-order";
import type { OrderInfo } from "@/lib/ai/order-state";

interface AiOrderConfirmDialogProps {
  conversationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a real order was created — the caller uses this to
   *  flip its own local state (e.g. hide the review button) without
   *  waiting on a realtime UPDATE. */
  onConfirmed?: () => void;
}

/**
 * The staff-side rescue path for the failure class this account kept
 * hitting all through August 2026 (see /api/conversations/[id]/ai-order's
 * doc): the AI's tool-calling path built up a real cart and order info
 * turn by turn, but never actually called place_order — a hallucinated
 * "pedido confirmado" with nothing behind it, or any other reason the
 * thread paused with useful state and no order to show for it. Opens
 * from AiThreadBanner's paused state; lets a human review — and edit,
 * since the AI's own cart-building has had real bugs (an item silently
 * missing, a quantity silently doubled) — before anything is
 * committed. Confirming runs it through the same finalizeDeliveryOrder
 * place_order itself uses, which unconditionally enqueues a print job.
 */
export function AiOrderConfirmDialog({
  conversationId,
  open,
  onOpenChange,
  onConfirmed,
}: AiOrderConfirmDialogProps) {
  const t = useTranslations("Inbox.aiOrderConfirm");

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [currency, setCurrency] = useState("USD");

  const [items, setItems] = useState<CartLineItem[]>([]);
  const [customerName, setCustomerName] = useState("");
  const [isPickup, setIsPickup] = useState(false);
  const [address, setAddress] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [paymentNotes, setPaymentNotes] = useState("");
  const [deliveryFee, setDeliveryFee] = useState(0);
  const [notes, setNotes] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/ai-order`);
      if (!res.ok) throw new Error("load failed");
      const data = (await res.json()) as { cart: CartLineItem[]; orderInfo: OrderInfo; currency: string };
      setItems(data.cart);
      setCurrency(data.currency);
      setCustomerName(data.orderInfo.customerName ?? "");
      setIsPickup(data.orderInfo.isPickup ?? false);
      setAddress(data.orderInfo.deliveryAddress ?? "");
      setPaymentMethod(data.orderInfo.paymentMethod ?? "");
      setPaymentNotes(data.orderInfo.paymentNotes ?? "");
      setDeliveryFee(data.orderInfo.lastFeeQuote?.fee ?? 0);
      setNotes("");
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const removeItem = (index: number) => setItems((prev) => prev.filter((_, i) => i !== index));
  const changeQuantity = (index: number, quantity: number) =>
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, quantity: Math.max(1, quantity) } : item)));

  const lineTotal = (item: CartLineItem) =>
    (item.unit_price + (item.addons ?? []).reduce((s, a) => s + a.price_delta, 0)) * item.quantity;
  const subtotal = items.reduce((sum, item) => sum + lineTotal(item), 0);
  const total = subtotal + (deliveryFee || 0);

  async function handleConfirm() {
    setConfirming(true);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/ai-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items,
          customer_name: customerName.trim() || null,
          is_pickup: isPickup,
          delivery_address: isPickup ? null : address.trim() || null,
          payment_method: paymentMethod.trim() || null,
          payment_notes: paymentNotes.trim() || null,
          delivery_fee: deliveryFee || 0,
          notes: notes.trim() || null,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(j?.error ?? t("errorToast"));
        return;
      }
      toast.success(t("successToast"));
      onOpenChange(false);
      onConfirmed?.();
    } catch {
      toast.error(t("errorToast"));
    } finally {
      setConfirming(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("dialogTitle")}</DialogTitle>
          <DialogDescription>{t("dialogDescription")}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : loadError ? (
          <p className="py-6 text-center text-sm text-destructive">{t("loadError")}</p>
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">{t("itemsTitle")}</Label>
              <div className="space-y-2 rounded-md border border-border">
                {items.map((item, i) => (
                  <div key={i} className="flex items-start gap-2 border-b border-border p-2 last:border-b-0">
                    <Input
                      type="number"
                      min={1}
                      value={item.quantity}
                      onChange={(e) => changeQuantity(i, Number(e.target.value) || 1)}
                      className="w-16"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{item.product_name}</p>
                      {(item.addons ?? []).length > 0 && (
                        <p className="truncate text-xs text-muted-foreground">
                          {(item.addons ?? []).map((a) => a.option_name).join(", ")}
                        </p>
                      )}
                      {item.notes?.trim() && (
                        <p className="truncate text-xs text-muted-foreground">[{item.notes.trim()}]</p>
                      )}
                    </div>
                    <span className="whitespace-nowrap text-sm text-muted-foreground">
                      {formatCurrency(lineTotal(item), currency)}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 flex-shrink-0 text-destructive"
                      onClick={() => removeItem(i)}
                      aria-label={t("removeItem")}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="ai-order-customer-name">{t("customerName")}</Label>
                <Input id="ai-order-customer-name" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
              </div>

              <div className="col-span-2 flex items-center justify-between rounded-md border border-border p-2">
                <Label htmlFor="ai-order-pickup" className="cursor-pointer">
                  {isPickup ? t("pickup") : t("delivery")}
                </Label>
                <Switch id="ai-order-pickup" checked={isPickup} onCheckedChange={setIsPickup} />
              </div>

              {!isPickup && (
                <div className="col-span-2 space-y-1.5">
                  <Label htmlFor="ai-order-address">{t("address")}</Label>
                  <Input
                    id="ai-order-address"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder={t("addressPlaceholder")}
                  />
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="ai-order-payment">{t("paymentMethod")}</Label>
                <Input id="ai-order-payment" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} />
              </div>

              {!isPickup && (
                <div className="space-y-1.5">
                  <Label htmlFor="ai-order-fee">{t("deliveryFee")}</Label>
                  <Input
                    id="ai-order-fee"
                    type="number"
                    min={0}
                    step="0.01"
                    value={deliveryFee}
                    onChange={(e) => setDeliveryFee(Number(e.target.value) || 0)}
                  />
                </div>
              )}

              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="ai-order-notes">{t("notes")}</Label>
                <Textarea id="ai-order-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
              </div>
            </div>

            <div className="space-y-1 rounded-md bg-muted/40 p-3 text-sm">
              <div className="flex justify-between text-muted-foreground">
                <span>{t("subtotal")}</span>
                <span>{formatCurrency(subtotal, currency)}</span>
              </div>
              <div className="flex justify-between font-medium text-foreground">
                <span>{t("total")}</span>
                <span>{formatCurrency(total, currency)}</span>
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button type="button" onClick={handleConfirm} disabled={items.length === 0 || confirming || loading}>
            {confirming ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {confirming ? t("confirming") : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
