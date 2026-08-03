"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { DeliveryCategory } from "@/types";
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
import { Switch } from "@/components/ui/switch";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

interface CategoryFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  category?: DeliveryCategory | null;
  nextPosition: number;
  onSaved: () => void;
}

export function CategoryFormDialog({
  open,
  onOpenChange,
  category,
  nextPosition,
  onSaved,
}: CategoryFormDialogProps) {
  const t = useTranslations("Delivery.categoryForm");
  const supabase = createClient();
  const { accountId } = useAuth();

  const [name, setName] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect -- legitimate prop-driven sync on open */
  useEffect(() => {
    if (!open) return;
    setConfirmDelete(false);
    setName(category?.name ?? "");
    setIsActive(category?.is_active ?? true);
  }, [open, category]);
  /* eslint-enable react-hooks/set-state-in-effect */

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);

    if (category) {
      const { error } = await supabase
        .from("delivery_categories")
        .update({ name: trimmed, is_active: isActive })
        .eq("id", category.id);
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
      const { error } = await supabase.from("delivery_categories").insert({
        account_id: accountId,
        name: trimmed,
        is_active: isActive,
        position: nextPosition,
      });
      setSaving(false);
      if (error) {
        toast.error(t("toastFailedCreate"));
        return;
      }
    }

    onOpenChange(false);
    onSaved();
    toast.success(category ? t("toastUpdated") : t("toastCreated"));
  }

  async function handleDelete() {
    if (!category) return;
    setDeleting(true);
    const { error } = await supabase
      .from("delivery_categories")
      .delete()
      .eq("id", category.id);
    setDeleting(false);
    if (error) {
      toast.error(t("toastFailedDelete"));
      return;
    }
    onOpenChange(false);
    onSaved();
    toast.success(t("toastDeleted"));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm bg-popover border-border">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {category ? t("editCategory") : t("newCategory")}
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t("name")}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("namePlaceholder")}
              className="border-border bg-muted text-foreground"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSave();
              }}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label className="text-foreground">{t("active")}</Label>
            <Switch checked={isActive} onCheckedChange={setIsActive} />
          </div>
        </div>

        <DialogFooter className="bg-popover/50 border-border">
          {category &&
            (confirmDelete ? (
              <div className="mr-auto flex items-center gap-2 text-xs">
                <span className="text-red-300">{t("deletePrompt")}</span>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={deleting}
                  className="rounded bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {deleting ? t("deleting") : t("confirm")}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="rounded px-2 py-1 text-muted-foreground hover:bg-muted"
                >
                  {t("cancel")}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="mr-auto flex items-center gap-1 text-xs text-red-400 hover:text-red-300"
              >
                <Trash2 className="h-3 w-3" />
                {t("deleteCategory")}
              </button>
            ))}
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t("cancel")}
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || !name.trim()}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {saving ? t("saving") : category ? t("saveChanges") : t("createCategory")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
