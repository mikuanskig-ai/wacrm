"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MODULE_KEYS } from "@/lib/accounts/modules";

export interface AdminPlan {
  id: string;
  name: string;
  description: string | null;
  price_cents: number;
  currency: string;
  billing_cycle: "monthly" | "quarterly" | "semiannual" | "annual";
  max_users: number | null;
  enabled_modules: string[];
  is_public: boolean;
  is_active: boolean;
  position: number;
}

interface PlanFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plan?: AdminPlan | null;
  onSaved: () => void;
}

const CYCLES = ["monthly", "quarterly", "semiannual", "annual"] as const;

export function PlanFormDialog({ open, onOpenChange, plan, onSaved }: PlanFormDialogProps) {
  const t = useTranslations("Admin.plans");

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [priceReais, setPriceReais] = useState("0");
  const [cycle, setCycle] = useState<(typeof CYCLES)[number]>("monthly");
  const [maxUsers, setMaxUsers] = useState<string>("");
  const [modules, setModules] = useState<string[]>([]);
  const [isPublic, setIsPublic] = useState(true);
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect -- legitimate prop-driven sync on open */
  useEffect(() => {
    if (!open) return;
    setName(plan?.name ?? "");
    setDescription(plan?.description ?? "");
    setPriceReais(plan ? (plan.price_cents / 100).toFixed(2) : "0");
    setCycle(plan?.billing_cycle ?? "monthly");
    setMaxUsers(plan?.max_users ? String(plan.max_users) : "");
    setModules(plan?.enabled_modules ?? []);
    setIsPublic(plan?.is_public ?? true);
    setIsActive(plan?.is_active ?? true);
  }, [open, plan]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function toggleModule(key: string, on: boolean) {
    setModules((prev) => (on ? [...new Set([...prev, key])] : prev.filter((m) => m !== key)));
  }

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) return;
    const priceCents = Math.round(Number(priceReais.replace(",", ".")) * 100);
    if (!Number.isFinite(priceCents) || priceCents < 0) {
      toast.error(t("invalidPrice"));
      return;
    }

    const body = {
      name: trimmed,
      description: description.trim() || null,
      price_cents: priceCents,
      billing_cycle: cycle,
      max_users: maxUsers.trim() ? Number(maxUsers) : null,
      enabled_modules: modules,
      is_public: isPublic,
      is_active: isActive,
    };

    setSaving(true);
    const res = await fetch(plan ? `/api/admin/plans/${plan.id}` : "/api/admin/plans", {
      method: plan ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaving(false);

    if (!res.ok) {
      toast.error(plan ? t("saveFailed") : t("createFailed"));
      return;
    }

    onOpenChange(false);
    onSaved();
    toast.success(plan ? t("saveSuccess") : t("createSuccess"));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{plan ? t("editPlan") : t("newPlan")}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label>{t("name")}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="grid gap-2">
            <Label>{t("description")}</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>{t("priceLabel")}</Label>
              <Input
                type="text"
                inputMode="decimal"
                value={priceReais}
                onChange={(e) => setPriceReais(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label>{t("cycleLabel")}</Label>
              <Select value={cycle} onValueChange={(v) => setCycle(v as typeof cycle)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CYCLES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {t(`cycle.${c}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-2">
            <Label>{t("maxUsersLabel")}</Label>
            <Input
              type="number"
              min={1}
              placeholder={t("maxUsersPlaceholder")}
              value={maxUsers}
              onChange={(e) => setMaxUsers(e.target.value)}
            />
          </div>

          <div className="grid gap-2">
            <Label>{t("modulesLabel")}</Label>
            {MODULE_KEYS.map((key) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                <Checkbox checked={modules.includes(key)} onCheckedChange={(v) => toggleModule(key, v === true)} />
                {key}
              </label>
            ))}
          </div>

          <div className="flex items-center justify-between">
            <Label>{t("isPublicLabel")}</Label>
            <Switch checked={isPublic} onCheckedChange={setIsPublic} />
          </div>
          <div className="flex items-center justify-between">
            <Label>{t("isActiveLabel")}</Label>
            <Switch checked={isActive} onCheckedChange={setIsActive} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button onClick={handleSave} disabled={saving || !name.trim()}>
            {saving ? t("saving") : plan ? t("saveChanges") : t("createPlan")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
