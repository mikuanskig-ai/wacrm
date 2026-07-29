"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type {
  DeliveryAddonGroup,
  DeliveryAddonOption,
  DeliveryAddonSelectionType,
} from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

interface AddonGroupEditorProps {
  productId: string;
}

type GroupWithOptions = DeliveryAddonGroup & { options: DeliveryAddonOption[] };

export function AddonGroupEditor({ productId }: AddonGroupEditorProps) {
  const t = useTranslations("Delivery.addonEditor");
  const supabase = createClient();
  const { accountId } = useAuth();

  const [groups, setGroups] = useState<GroupWithOptions[]>([]);
  const [loading, setLoading] = useState(true);
  const [newGroupName, setNewGroupName] = useState("");

  const load = useCallback(async () => {
    const { data: groupRows } = await supabase
      .from("delivery_addon_groups")
      .select("*")
      .eq("product_id", productId)
      .order("position");
    const groupList = (groupRows ?? []) as DeliveryAddonGroup[];
    if (groupList.length === 0) {
      setGroups([]);
      return;
    }
    const { data: optionRows } = await supabase
      .from("delivery_addon_options")
      .select("*")
      .in("group_id", groupList.map((g) => g.id))
      .order("position");
    const options = (optionRows ?? []) as DeliveryAddonOption[];
    setGroups(
      groupList.map((g) => ({
        ...g,
        options: options.filter((o) => o.group_id === g.id),
      })),
    );
  }, [supabase, productId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kicks off the async load, settled inside the .finally callback
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  async function handleAddGroup() {
    const trimmed = newGroupName.trim();
    if (!trimmed || !accountId) return;
    const { error } = await supabase.from("delivery_addon_groups").insert({
      account_id: accountId,
      product_id: productId,
      name: trimmed,
      selection_type: "single",
      position: groups.length,
    });
    if (error) {
      toast.error(t("toastFailedAddGroup"));
      return;
    }
    setNewGroupName("");
    load();
  }

  async function handleUpdateGroup(group: DeliveryAddonGroup, patch: Partial<DeliveryAddonGroup>) {
    const { error } = await supabase
      .from("delivery_addon_groups")
      .update(patch)
      .eq("id", group.id);
    if (error) {
      toast.error(t("toastFailedSave"));
      return;
    }
    load();
  }

  async function handleRemoveGroup(groupId: string) {
    const { error } = await supabase.from("delivery_addon_groups").delete().eq("id", groupId);
    if (error) {
      toast.error(t("toastFailedRemoveGroup"));
      return;
    }
    load();
  }

  async function handleAddOption(group: GroupWithOptions) {
    if (!accountId) return;
    const { error } = await supabase.from("delivery_addon_options").insert({
      account_id: accountId,
      group_id: group.id,
      name: t("newOptionDefaultName"),
      price_delta: 0,
      position: group.options.length,
    });
    if (error) {
      toast.error(t("toastFailedAddOption"));
      return;
    }
    load();
  }

  async function handleUpdateOption(option: DeliveryAddonOption, patch: Partial<DeliveryAddonOption>) {
    const { error } = await supabase
      .from("delivery_addon_options")
      .update(patch)
      .eq("id", option.id);
    if (error) {
      toast.error(t("toastFailedSave"));
      return;
    }
    load();
  }

  async function handleRemoveOption(optionId: string) {
    const { error } = await supabase.from("delivery_addon_options").delete().eq("id", optionId);
    if (error) {
      toast.error(t("toastFailedRemoveOption"));
      return;
    }
    load();
  }

  if (loading) {
    return <div className="h-16 animate-pulse rounded-lg bg-muted/50" />;
  }

  return (
    <div className="grid gap-3">
      {groups.map((group) => (
        <div key={group.id} className="rounded-lg border border-border bg-muted/40 p-3">
          <div className="flex items-center gap-2">
            <Input
              value={group.name}
              onChange={(e) =>
                setGroups((prev) =>
                  prev.map((g) => (g.id === group.id ? { ...g, name: e.target.value } : g)),
                )
              }
              onBlur={(e) => handleUpdateGroup(group, { name: e.target.value.trim() || group.name })}
              className="h-8 flex-1 border-border bg-muted text-sm text-foreground"
            />
            <Select
              value={group.selection_type}
              onValueChange={(v) =>
                v && handleUpdateGroup(group, { selection_type: v as DeliveryAddonSelectionType })
              }
            >
              <SelectTrigger className="h-8 w-32 border-border bg-muted text-xs text-foreground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="single">{t("selectionSingle")}</SelectItem>
                <SelectItem value="multiple">{t("selectionMultiple")}</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground">{t("required")}</Label>
              <Switch
                checked={group.is_required}
                onCheckedChange={(v) => handleUpdateGroup(group, { is_required: v })}
              />
            </div>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => handleRemoveGroup(group.id)}
              className="text-muted-foreground hover:text-red-400"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>

          <div className="mt-2 grid gap-1.5">
            {group.options.map((option) => (
              <div key={option.id} className="flex items-center gap-2">
                <Input
                  value={option.name}
                  onChange={(e) =>
                    setGroups((prev) =>
                      prev.map((g) =>
                        g.id === group.id
                          ? {
                              ...g,
                              options: g.options.map((o) =>
                                o.id === option.id ? { ...o, name: e.target.value } : o,
                              ),
                            }
                          : g,
                      ),
                    )
                  }
                  onBlur={(e) => handleUpdateOption(option, { name: e.target.value.trim() || option.name })}
                  className="h-7 flex-1 border-transparent bg-transparent text-xs text-foreground focus:border-border"
                  placeholder={t("optionNamePlaceholder")}
                />
                <Input
                  type="number"
                  step="0.01"
                  value={option.price_delta}
                  onChange={(e) =>
                    setGroups((prev) =>
                      prev.map((g) =>
                        g.id === group.id
                          ? {
                              ...g,
                              options: g.options.map((o) =>
                                o.id === option.id
                                  ? { ...o, price_delta: Number(e.target.value) }
                                  : o,
                              ),
                            }
                          : g,
                      ),
                    )
                  }
                  onBlur={(e) => handleUpdateOption(option, { price_delta: Number(e.target.value) || 0 })}
                  className="h-7 w-20 border-border bg-muted text-xs text-foreground"
                />
                <Switch
                  checked={option.is_active}
                  onCheckedChange={(v) => handleUpdateOption(option, { is_active: v })}
                />
                <button
                  type="button"
                  onClick={() => handleRemoveOption(option.id)}
                  className="text-muted-foreground hover:text-red-400"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleAddOption(group)}
              className="w-fit text-xs text-muted-foreground hover:text-foreground"
            >
              <Plus className="mr-1 h-3 w-3" />
              {t("addOption")}
            </Button>
          </div>
        </div>
      ))}

      <div className="flex items-center gap-2">
        <Input
          value={newGroupName}
          onChange={(e) => setNewGroupName(e.target.value)}
          placeholder={t("newGroupPlaceholder")}
          className="h-8 border-border bg-muted text-sm text-foreground"
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAddGroup();
          }}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={handleAddGroup}
          disabled={!newGroupName.trim()}
          className="shrink-0 border-border bg-transparent text-muted-foreground hover:bg-muted"
        >
          <Plus className="mr-1 h-3 w-3" />
          {t("addGroup")}
        </Button>
      </div>
    </div>
  );
}
