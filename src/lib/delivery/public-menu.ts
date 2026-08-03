// ============================================================
// Public cardápio (Fase 6: Escala) — resolves an account by its
// public URL slug and loads its menu in bulk for the unauthenticated
// /c/[slug] page + its API routes. Callers always pass the
// service-role client (src/lib/payments/admin-client.ts's
// `supabaseAdmin()`) — none of this reads through RLS, since a public
// visitor is never an account member.
//
// `loadPublicMenu` batches its reads (one query per table, `.in()` for
// the addon tables) rather than reusing the per-product
// `loadProductWithAddonGroups` from src/lib/flows/engine.ts, which
// would N+1 for a menu with many items.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { hasModule } from '@/lib/accounts/modules';
import { effectivePrice, type DayPriceOverrides } from './day-price';

export interface PublicMenuAddonOption {
  id: string;
  name: string;
  price_delta: number;
}

export interface PublicMenuAddonGroup {
  id: string;
  name: string;
  selection_type: 'single' | 'multiple';
  is_required: boolean;
  min_select: number;
  max_select: number | null;
  options: PublicMenuAddonOption[];
}

export interface PublicMenuProduct {
  id: string;
  name: string;
  description: string | null;
  price: number;
  image_url: string | null;
  position: number;
  addon_groups: PublicMenuAddonGroup[];
}

export interface PublicMenuCategory {
  id: string;
  name: string;
  position: number;
  products: PublicMenuProduct[];
}

export interface PublicAccount {
  id: string;
  name: string;
  currency: string;
}

/**
 * Null when the slug is unset/unknown, the account doesn't have the
 * `delivery` module enabled, OR the account is suspended (migration
 * 062) — deliberately the same result for all three, so a 404 built
 * on top of this never leaks which case it was.
 */
export async function resolveAccountBySlug(
  db: SupabaseClient,
  slug: string,
): Promise<PublicAccount | null> {
  const { data } = await db
    .from('accounts')
    .select('id, name, default_currency, enabled_modules, status')
    .eq('slug', slug)
    .maybeSingle();

  if (!data) return null;
  if (!hasModule(data, 'delivery')) return null;
  if (data.status === 'suspended') return null;

  return { id: data.id, name: data.name, currency: data.default_currency };
}

export async function isSlugAvailable(
  db: SupabaseClient,
  slug: string,
  excludeAccountId?: string,
): Promise<boolean> {
  let query = db.from('accounts').select('id').eq('slug', slug);
  if (excludeAccountId) query = query.neq('id', excludeAccountId);
  const { data } = await query.maybeSingle();
  return !data;
}

export async function loadPublicMenu(
  db: SupabaseClient,
  accountId: string,
): Promise<{ categories: PublicMenuCategory[]; uncategorizedProducts: PublicMenuProduct[] }> {
  const { data: categoryRows } = await db
    .from('delivery_categories')
    .select('id, name, position')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('position');

  const { data: productRows } = await db
    .from('delivery_products')
    .select('id, category_id, name, description, price, day_price_overrides, image_url, position')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('position');

  const products = productRows ?? [];
  const productIds = products.map((p) => p.id);

  let groupRows: {
    id: string;
    product_id: string;
    name: string;
    selection_type: 'single' | 'multiple';
    is_required: boolean;
    min_select: number;
    max_select: number | null;
  }[] = [];
  let optionRows: { id: string; group_id: string; name: string; price_delta: number }[] = [];

  if (productIds.length > 0) {
    const { data: groups } = await db
      .from('delivery_addon_groups')
      .select('id, product_id, name, selection_type, is_required, min_select, max_select')
      .in('product_id', productIds)
      .order('position');
    groupRows = groups ?? [];

    const groupIds = groupRows.map((g) => g.id);
    if (groupIds.length > 0) {
      const { data: options } = await db
        .from('delivery_addon_options')
        .select('id, group_id, name, price_delta')
        .in('group_id', groupIds)
        .eq('is_active', true)
        .order('position');
      optionRows = options ?? [];
    }
  }

  const buildProduct = (row: (typeof products)[number]): PublicMenuProduct => ({
    id: row.id,
    name: row.name,
    description: row.description,
    price: effectivePrice(row.price, row.day_price_overrides as DayPriceOverrides | null),
    image_url: row.image_url,
    position: row.position,
    addon_groups: groupRows
      .filter((g) => g.product_id === row.id)
      .map((g) => ({
        id: g.id,
        name: g.name,
        selection_type: g.selection_type,
        is_required: g.is_required,
        min_select: g.min_select,
        max_select: g.max_select,
        options: optionRows
          .filter((o) => o.group_id === g.id)
          .map((o) => ({ id: o.id, name: o.name, price_delta: o.price_delta })),
      })),
  });

  const categories: PublicMenuCategory[] = (categoryRows ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    position: c.position,
    products: products.filter((p) => p.category_id === c.id).map(buildProduct),
  }));

  const uncategorizedProducts = products
    .filter((p) => !p.category_id)
    .map(buildProduct);

  return { categories, uncategorizedProducts };
}
