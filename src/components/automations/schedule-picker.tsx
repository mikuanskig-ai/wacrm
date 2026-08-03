"use client";

/**
 * Visual time-of-day + day-of-week picker for the `time_based` trigger
 * (UX audit Parte 5, Meses 4-6 — the raw text input asked for a cron
 * expression like "0 9 * * 1-5" with zero visual affordance). Reads
 * and writes the exact same `config.schedule` string the engine
 * already expects — this only changes how it's authored, not the
 * stored format, so nothing server-side needs to change.
 *
 * Anything the picker can't confidently parse (a step interval like
 * "*\/15 * * * *", an out-of-range field, free text) falls back to a
 * raw-text "advanced" mode rather than silently mangling it — an
 * automation someone hand-wrote a real cron expression for must keep
 * working exactly as before.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const DOW_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const ALL_DAYS = new Set([0, 1, 2, 3, 4, 5, 6]);
const WEEKDAYS = new Set([1, 2, 3, 4, 5]);

interface ParsedSchedule {
  hour: number;
  minute: number;
  days: Set<number>;
}

function parseDowField(field: string): Set<number> | null {
  if (field === "*") return new Set(ALL_DAYS);
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const range = /^([0-6])-([0-6])$/.exec(part.trim());
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from > to) return null;
      for (let d = from; d <= to; d++) days.add(d);
      continue;
    }
    if (/^[0-6]$/.test(part.trim())) {
      days.add(Number(part.trim()));
      continue;
    }
    return null;
  }
  return days.size > 0 ? days : null;
}

export function parseSchedule(value: string): ParsedSchedule | null {
  const trimmed = value.trim();
  const bareTime = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (bareTime) {
    const hour = Number(bareTime[1]);
    const minute = Number(bareTime[2]);
    if (hour > 23 || minute > 59) return null;
    return { hour, minute, days: new Set(ALL_DAYS) };
  }
  const cron = /^(\d{1,2}) (\d{1,2}) \* \* (.+)$/.exec(trimmed);
  if (!cron) return null;
  const minute = Number(cron[1]);
  const hour = Number(cron[2]);
  if (minute > 59 || hour > 23) return null;
  const days = parseDowField(cron[3].trim());
  return days ? { hour, minute, days } : null;
}

export function buildCron(hour: number, minute: number, days: Set<number>): string {
  const dow = days.size === 7 ? "*" : [...days].sort().join(",");
  return `${minute} ${hour} * * ${dow}`;
}

const DEFAULT_SCHEDULE: ParsedSchedule = { hour: 9, minute: 0, days: WEEKDAYS };

export function SchedulePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const t = useTranslations("Automations.builder");
  const tDay = useTranslations("Automations.builder.scheduleDays");

  const parsed = useMemo(() => parseSchedule(value), [value]);
  const [advanced, setAdvanced] = useState(parsed === null && value.trim() !== "");

  // First time this trigger is configured, `value` is still "" — write
  // the visual default immediately so what's shown always matches
  // what's actually stored, instead of a picker that looks configured
  // while `config.schedule` stays empty until some other interaction.
  useEffect(() => {
    if (parsed === null && value.trim() === "") {
      onChange(buildCron(DEFAULT_SCHEDULE.hour, DEFAULT_SCHEDULE.minute, DEFAULT_SCHEDULE.days));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (advanced) {
    return (
      <div>
        <Input
          placeholder="0 9 * * 1-5"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="bg-muted font-mono text-foreground"
        />
        <button
          type="button"
          onClick={() => setAdvanced(false)}
          className="mt-1 text-[11px] text-primary hover:underline"
        >
          {t("scheduleUseVisual")}
        </button>
      </div>
    );
  }

  const current = parsed ?? DEFAULT_SCHEDULE;

  function update(next: Partial<ParsedSchedule>) {
    onChange(
      buildCron(next.hour ?? current.hour, next.minute ?? current.minute, next.days ?? current.days),
    );
  }

  function toggleDay(d: number) {
    const days = new Set(current.days);
    if (days.has(d)) {
      if (days.size === 1) return; // never allow zero days selected
      days.delete(d);
    } else {
      days.add(d);
    }
    update({ days });
  }

  const isEveryDay = current.days.size === 7;
  const isWeekdaysOnly =
    current.days.size === 5 && [...WEEKDAYS].every((d) => current.days.has(d));

  return (
    <div className="space-y-2">
      <input
        type="time"
        value={`${String(current.hour).padStart(2, "0")}:${String(current.minute).padStart(2, "0")}`}
        onChange={(e) => {
          const [h, m] = e.target.value.split(":").map(Number);
          if (Number.isFinite(h) && Number.isFinite(m)) update({ hour: h, minute: m });
        }}
        className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
      />
      <div className="flex flex-wrap gap-1">
        {DOW_KEYS.map((key, cronValue) => {
          const active = current.days.has(cronValue);
          return (
            <button
              key={key}
              type="button"
              onClick={() => toggleDay(cronValue)}
              aria-pressed={active}
              className={cn(
                "flex h-7 w-9 items-center justify-center rounded-md border text-xs font-medium transition-colors",
                active
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-muted text-muted-foreground hover:bg-muted/70",
              )}
            >
              {tDay(key)}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-3 text-[11px]">
        <button
          type="button"
          onClick={() => update({ days: new Set(WEEKDAYS) })}
          className={cn("hover:underline", isWeekdaysOnly ? "text-primary" : "text-muted-foreground")}
        >
          {t("scheduleWeekdays")}
        </button>
        <button
          type="button"
          onClick={() => update({ days: new Set(ALL_DAYS) })}
          className={cn("hover:underline", isEveryDay ? "text-primary" : "text-muted-foreground")}
        >
          {t("scheduleEveryDay")}
        </button>
        <button
          type="button"
          onClick={() => setAdvanced(true)}
          className="ml-auto text-muted-foreground hover:underline"
        >
          {t("scheduleAdvanced")}
        </button>
      </div>
    </div>
  );
}
