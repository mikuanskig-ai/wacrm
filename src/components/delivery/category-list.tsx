"use client";

import { useState } from "react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { createClient } from "@/lib/supabase/client";
import type { DeliveryCategory } from "@/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { GripVertical, Plus, Pencil, UtensilsCrossed } from "lucide-react";
import { useCan } from "@/hooks/use-can";
import { useTranslations } from "next-intl";

interface CategoryListProps {
  categories: DeliveryCategory[];
  selectedCategoryId: string | null;
  onSelectCategory: (id: string | null) => void;
  onAddCategory: () => void;
  onEditCategory: (category: DeliveryCategory) => void;
  onReordered: () => void;
}

export function CategoryList({
  categories,
  selectedCategoryId,
  onSelectCategory,
  onAddCategory,
  onEditCategory,
  onReordered,
}: CategoryListProps) {
  const t = useTranslations("Delivery.categoryList");
  const supabase = createClient();
  const canEdit = useCan("edit-settings");
  const [localOrder, setLocalOrder] = useState<DeliveryCategory[] | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const list = localOrder ?? categories;

  async function handleReorder(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = list.findIndex((c) => c.id === active.id);
    const newIndex = list.findIndex((c) => c.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const reordered = arrayMove(list, oldIndex, newIndex);
    setLocalOrder(reordered);

    await Promise.all(
      reordered.map((c, i) =>
        supabase.from("delivery_categories").update({ position: i }).eq("id", c.id),
      ),
    );
    onReordered();
    setLocalOrder(null);
  }

  return (
    <div className="flex w-56 shrink-0 flex-col gap-1">
      <button
        type="button"
        onClick={() => onSelectCategory(null)}
        className={cn(
          "flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors",
          selectedCategoryId === null
            ? "bg-primary/10 text-primary"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <UtensilsCrossed className="h-4 w-4" />
        {t("allProducts")}
      </button>

      {categories.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">{t("noCategories")}</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleReorder}>
          <SortableContext items={list.map((c) => c.id)} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-1">
              {list.map((category) => (
                <SortableCategoryRow
                  key={category.id}
                  category={category}
                  isSelected={selectedCategoryId === category.id}
                  canEdit={canEdit}
                  onSelect={() => onSelectCategory(category.id)}
                  onEdit={() => onEditCategory(category)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {canEdit && (
        <Button
          variant="outline"
          size="sm"
          onClick={onAddCategory}
          className="mt-2 border-border bg-transparent text-muted-foreground hover:bg-muted"
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          {t("addCategory")}
        </Button>
      )}
    </div>
  );
}

function SortableCategoryRow({
  category,
  isSelected,
  canEdit,
  onSelect,
  onEdit,
}: {
  category: DeliveryCategory;
  isSelected: boolean;
  canEdit: boolean;
  onSelect: () => void;
  onEdit: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: category.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group flex items-center gap-1 rounded-lg px-1 py-1 text-sm font-medium transition-colors",
        isSelected ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {canEdit && (
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="cursor-grab touch-none px-1 text-muted-foreground/60 hover:text-foreground active:cursor-grabbing"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
      )}
      <button type="button" onClick={onSelect} className="flex-1 truncate py-1 text-left">
        {category.name}
        {!category.is_active && (
          <span className="ml-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/70">
            •
          </span>
        )}
      </button>
      {canEdit && (
        <button
          type="button"
          onClick={onEdit}
          className="hidden shrink-0 px-1 text-muted-foreground hover:text-foreground group-hover:block"
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
