"use client";

import { useState } from "react";
import type { DateRange } from "react-day-picker";
import { ptBR } from "react-day-picker/locale";
import { endOfDay, endOfWeek, format, startOfDay, startOfWeek, subDays } from "date-fns";
import { ptBR as ptBRFns } from "date-fns/locale";
import { Calendar as CalendarIcon, ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";

/** Inclusive UTC-agnostic day range — `from` is start-of-day, `to` is
 *  end-of-day, so a caller can pass both straight into `.gte()`/`.lte()`
 *  against `created_at` without off-by-one edge cases at the boundary. */
export interface OrderDateRange {
  from: Date;
  to: Date;
}

interface Preset {
  key: string;
  range: () => OrderDateRange;
}

const PRESETS: Preset[] = [
  { key: "today", range: () => ({ from: startOfDay(new Date()), to: endOfDay(new Date()) }) },
  {
    key: "yesterday",
    range: () => {
      const y = subDays(new Date(), 1);
      return { from: startOfDay(y), to: endOfDay(y) };
    },
  },
  {
    key: "thisWeek",
    range: () => ({ from: startOfWeek(new Date(), { weekStartsOn: 1 }), to: endOfDay(new Date()) }),
  },
  {
    key: "lastWeek",
    range: () => {
      const ref = subDays(new Date(), 7);
      return {
        from: startOfWeek(ref, { weekStartsOn: 1 }),
        to: endOfWeek(ref, { weekStartsOn: 1 }),
      };
    },
  },
  { key: "last30Days", range: () => ({ from: startOfDay(subDays(new Date(), 29)), to: endOfDay(new Date()) }) },
  { key: "last90Days", range: () => ({ from: startOfDay(subDays(new Date(), 89)), to: endOfDay(new Date()) }) },
];

function sameRange(a: OrderDateRange, b: OrderDateRange): boolean {
  return a.from.getTime() === b.from.getTime() && a.to.getTime() === b.to.getTime();
}

function formatRangeLabel(range: OrderDateRange | null): string | null {
  if (!range) return null;
  const from = format(range.from, "d 'de' MMM", { locale: ptBRFns });
  const to = format(range.to, "d 'de' MMM 'de' yyyy", { locale: ptBRFns });
  return `${from} a ${to}`;
}

interface OrderDateRangeFilterProps {
  /** `null` = no filter applied, every order loads. */
  value: OrderDateRange | null;
  onChange: (range: OrderDateRange | null) => void;
}

/** Popover date-range filter for the Pedidos list — a shortcuts sidebar
 *  (Hoje/Ontem/Semana passada/Essa semana/30 dias/90 dias) plus a
 *  two-month calendar for a custom range, with explicit Cancelar/
 *  Atualizar so a half-picked range on the calendar never applies
 *  itself before the admin means it to. */
export function OrderDateRangeFilter({ value, onChange }: OrderDateRangeFilterProps) {
  const t = useTranslations("Delivery.ordersPage.dateFilter");
  const [open, setOpen] = useState(false);
  // Draft state — the calendar/preset selection only reaches `value`
  // (and therefore only re-queries the order list) once "Atualizar" is
  // pressed, so clicking around the calendar never fires a query per click.
  const [draft, setDraft] = useState<OrderDateRange | null>(value);

  const activePresetKey = PRESETS.find((p) => value && sameRange(p.range(), value))?.key ?? null;
  const label = formatRangeLabel(value);

  const openChange = (next: boolean) => {
    if (next) setDraft(value); // reset the draft to the applied value each time it opens
    setOpen(next);
  };

  return (
    <Popover open={open} onOpenChange={openChange}>
      <PopoverTrigger
        render={
          <Button variant="outline" className="border-border bg-card text-foreground hover:bg-muted">
            <CalendarIcon className="mr-1.5 h-4 w-4 text-muted-foreground" />
            {label ? `${t(activePresetKey ?? "custom")}: ${label}` : t("allTime")}
            <ChevronDown className="ml-1.5 h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        }
      />
      <PopoverContent align="start" className="w-auto p-0">
        <div className="flex flex-col sm:flex-row">
          <div className="flex shrink-0 flex-col gap-0.5 border-b border-border p-2 sm:w-44 sm:border-r sm:border-b-0">
            <button
              type="button"
              onClick={() => setDraft(null)}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted",
                draft === null ? "bg-primary/10 text-primary" : "text-foreground",
              )}
            >
              {t("allTime")}
            </button>
            {PRESETS.map((preset) => {
              const range = preset.range();
              const isActive = draft ? sameRange(draft, range) : false;
              return (
                <button
                  key={preset.key}
                  type="button"
                  onClick={() => setDraft(range)}
                  className={cn(
                    "rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted",
                    isActive ? "bg-primary/10 text-primary" : "text-foreground",
                  )}
                >
                  {t(preset.key)}
                </button>
              );
            })}
          </div>

          <div className="flex flex-col gap-2 p-2">
            <Calendar
              mode="range"
              locale={ptBR}
              numberOfMonths={2}
              defaultMonth={draft?.from ?? subDays(new Date(), 31)}
              selected={draft ? { from: draft.from, to: draft.to } : undefined}
              onSelect={(range: DateRange | undefined) => {
                if (!range?.from) {
                  setDraft(null);
                  return;
                }
                setDraft({
                  from: startOfDay(range.from),
                  to: endOfDay(range.to ?? range.from),
                });
              }}
            />
            <div className="flex justify-end gap-2 border-t border-border pt-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
                {t("cancel")}
              </Button>
              <Button
                type="button"
                size="sm"
                className="bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={() => {
                  onChange(draft);
                  setOpen(false);
                }}
              >
                {t("apply")}
              </Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
