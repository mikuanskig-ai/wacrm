"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Blocks, Loader2, UtensilsCrossed } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { MODULE_KEYS, type ModuleKey } from "@/lib/accounts/modules";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { useTranslations } from "next-intl";
import { SettingsPanelHead } from "./settings-panel-head";

// Per-module display metadata. Add an entry here (and to MODULE_KEYS in
// lib/accounts/modules.ts) when the next opt-in vertical ships — no
// other file in this component needs to change.
const MODULE_META: Record<ModuleKey, { icon: typeof Blocks }> = {
  delivery: { icon: UtensilsCrossed },
};

/**
 * Modules settings — opt-in feature verticals (migration 041).
 *
 * Each account chooses which larger add-on modules it wants turned on
 * for itself (Delivery is the first). Mirrors DealsSettings' local-
 * state/dirty/save shape; writes go straight to
 * `accounts.enabled_modules`, gated the same way `accounts.update` RLS
 * already restricts writes to admins+.
 */
export function ModulesSettings() {
  const supabase = createClient();
  const { accountId, account, canEditSettings, profileLoading, refreshProfile } =
    useAuth();
  const t = useTranslations("Settings.modules");

  const [enabled, setEnabled] = useState<string[]>(account?.enabled_modules ?? []);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- legitimate prop-driven sync
    setEnabled(account?.enabled_modules ?? []);
  }, [account?.enabled_modules]);

  const dirty =
    enabled.length !== (account?.enabled_modules ?? []).length ||
    enabled.some((k) => !(account?.enabled_modules ?? []).includes(k));

  function toggle(key: ModuleKey, on: boolean) {
    setEnabled((prev) =>
      on ? [...new Set([...prev, key])] : prev.filter((k) => k !== key),
    );
  }

  async function handleSave() {
    if (!accountId || !dirty) return;
    setSaving(true);
    const { error } = await supabase
      .from("accounts")
      .update({ enabled_modules: enabled })
      .eq("id", accountId);
    if (error) {
      toast.error(t("saveFailed"));
      setSaving(false);
      return;
    }
    await refreshProfile();
    setSaving(false);
    toast.success(t("saveSuccess"));
  }

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t("title")} description={t("description")} />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Blocks className="size-4 text-primary" />
            {t("cardTitle")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("cardDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3">
            {MODULE_KEYS.map((key) => {
              const Icon = MODULE_META[key].icon;
              return (
                <div
                  key={key}
                  className="flex items-start justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3"
                >
                  <div className="flex items-start gap-2.5">
                    <Icon className="mt-0.5 size-4 shrink-0 text-primary" />
                    <div className="grid gap-0.5">
                      <span className="text-sm font-medium text-foreground">
                        {t(`${key}Label`)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {t(`${key}Desc`)}
                      </span>
                    </div>
                  </div>
                  <Switch
                    checked={enabled.includes(key)}
                    onCheckedChange={(v) => toggle(key, v)}
                    disabled={!canEditSettings || profileLoading}
                  />
                </div>
              );
            })}
            {!canEditSettings && (
              <p className="text-xs text-muted-foreground">{t("adminOnlyHint")}</p>
            )}
          </div>

          {canEditSettings && (
            <Button
              onClick={handleSave}
              disabled={saving || !dirty}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t("saving")}
                </>
              ) : (
                t("save")
              )}
            </Button>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
