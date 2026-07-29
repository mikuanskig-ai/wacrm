'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Minus, Plus } from 'lucide-react';
import { formatCurrency } from '@/lib/currency';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import type { CartAddon, PublicProduct } from './types';

export function PublicMenuProductModal({
  product,
  currency,
  onClose,
  onAdd,
}: {
  product: PublicProduct;
  currency: string;
  onClose: () => void;
  onAdd: (args: { quantity: number; addons: CartAddon[]; notes: string | null }) => void;
}) {
  const t = useTranslations('PublicMenu.product');
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState('');

  const toggleOption = (groupId: string, optionId: string, multiple: boolean) => {
    setSelections((prev) => {
      const current = prev[groupId] ?? [];
      if (multiple) {
        const next = current.includes(optionId)
          ? current.filter((id) => id !== optionId)
          : [...current, optionId];
        return { ...prev, [groupId]: next };
      }
      // Single-select: clicking the already-selected option clears it
      // when the group isn't required, otherwise just replaces it.
      const group = product.addon_groups.find((g) => g.id === groupId);
      if (current[0] === optionId && !group?.is_required) {
        return { ...prev, [groupId]: [] };
      }
      return { ...prev, [groupId]: [optionId] };
    });
  };

  const isValid = useMemo(
    () =>
      product.addon_groups.every((group) => {
        const count = selections[group.id]?.length ?? 0;
        const min = group.is_required ? Math.max(group.min_select, 1) : group.min_select;
        if (count < min) return false;
        if (group.max_select != null && count > group.max_select) return false;
        return true;
      }),
    [product.addon_groups, selections],
  );

  const selectedAddons: CartAddon[] = useMemo(
    () =>
      product.addon_groups.flatMap((group) =>
        (selections[group.id] ?? []).map((optionId) => {
          const option = group.options.find((o) => o.id === optionId)!;
          return {
            group_id: group.id,
            group_name: group.name,
            option_id: option.id,
            option_name: option.name,
            price_delta: option.price_delta,
          };
        }),
      ),
    [product.addon_groups, selections],
  );

  const unitTotal = product.price + selectedAddons.reduce((s, a) => s + a.price_delta, 0);
  const lineTotal = unitTotal * quantity;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{product.name}</DialogTitle>
          {product.description && <DialogDescription>{product.description}</DialogDescription>}
        </DialogHeader>

        <div className="space-y-5">
          {product.addon_groups.map((group) => (
            <div key={group.id}>
              <div className="mb-2 flex items-baseline justify-between">
                <p className="text-sm font-medium text-foreground">{group.name}</p>
                {group.is_required && (
                  <span className="text-xs text-muted-foreground">{t('addonsRequired')}</span>
                )}
              </div>
              <div className="space-y-1.5">
                {group.options.map((option) => {
                  const checked = (selections[group.id] ?? []).includes(option.id);
                  return (
                    <label
                      key={option.id}
                      className="flex cursor-pointer items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5"
                    >
                      <span className="flex items-center gap-2">
                        <input
                          type={group.selection_type === 'multiple' ? 'checkbox' : 'radio'}
                          name={group.id}
                          checked={checked}
                          onChange={() =>
                            toggleOption(group.id, option.id, group.selection_type === 'multiple')
                          }
                          className="h-4 w-4"
                        />
                        {option.name}
                      </span>
                      {option.price_delta !== 0 && (
                        <span className="text-muted-foreground">
                          {option.price_delta > 0 ? '+' : ''}
                          {formatCurrency(option.price_delta, currency)}
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}

          <div>
            <p className="mb-1.5 text-sm font-medium text-foreground">{t('quantity')}</p>
            <div className="flex items-center gap-3">
              <Button
                type="button"
                size="icon-sm"
                variant="outline"
                onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              >
                <Minus className="h-3.5 w-3.5" />
              </Button>
              <span className="w-6 text-center text-sm font-medium text-foreground">{quantity}</span>
              <Button
                type="button"
                size="icon-sm"
                variant="outline"
                onClick={() => setQuantity((q) => Math.min(20, q + 1))}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-sm font-medium text-foreground">{t('notes')}</p>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            onClick={() =>
              onAdd({ quantity, addons: selectedAddons, notes: notes.trim() || null })
            }
            disabled={!isValid}
            className="w-full sm:w-auto"
          >
            {t('addFor', { price: formatCurrency(lineTotal, currency) })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
