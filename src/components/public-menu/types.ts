// Shapes returned by GET /api/public/menu/[slug] and the client-side
// cart built on top of them. Kept separate from src/types/index.ts —
// these are public-page-only, never touch a dashboard component.

export interface PublicAddonOption {
  id: string;
  name: string;
  price_delta: number;
}

export interface PublicAddonGroup {
  id: string;
  name: string;
  selection_type: 'single' | 'multiple';
  is_required: boolean;
  min_select: number;
  max_select: number | null;
  options: PublicAddonOption[];
}

export interface PublicProduct {
  id: string;
  name: string;
  description: string | null;
  price: number;
  image_url: string | null;
  position: number;
  addon_groups: PublicAddonGroup[];
}

export interface PublicCategory {
  id: string;
  name: string;
  position: number;
  products: PublicProduct[];
}

export interface PublicMenuResponse {
  account: { name: string; currency: string };
  open: boolean;
  closed_message: string | null;
  categories: PublicCategory[];
  uncategorized_products: PublicProduct[];
}

export interface CartAddon {
  group_id: string;
  group_name: string;
  option_id: string;
  option_name: string;
  price_delta: number;
}

export interface CartEntry {
  /** Client-only key (product_id + sorted option ids), lets identical
   *  picks merge into one line and distinct picks stay separate. */
  key: string;
  product_id: string;
  product_name: string;
  unit_price: number;
  quantity: number;
  addons: CartAddon[];
  notes: string | null;
}

export function cartEntryKey(productId: string, optionIds: string[]): string {
  return `${productId}:${[...optionIds].sort().join(',')}`;
}

export function cartLineTotal(entry: CartEntry): number {
  const addonsTotal = entry.addons.reduce((s, a) => s + a.price_delta, 0);
  return (entry.unit_price + addonsTotal) * entry.quantity;
}

export function cartTotal(cart: CartEntry[]): number {
  return cart.reduce((sum, entry) => sum + cartLineTotal(entry), 0);
}
