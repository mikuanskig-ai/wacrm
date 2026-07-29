import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveAccountBySlug, isSlugAvailable, loadPublicMenu } from './public-menu';

// Generic chainable fake query builder — each eq/in call narrows the
// seeded rows in-memory (mirroring what the equivalent real Postgres
// filter would do), so tests actually exercise the exclusion logic
// (inactive rows, wrong account, etc.) rather than just the shape.
function makeQueryChain<T extends Record<string, unknown>>(rows: T[]) {
  let filtered = rows;
  const chain = {
    select: () => chain,
    eq: (col: string, val: unknown) => {
      filtered = filtered.filter((r) => r[col] === val);
      return chain;
    },
    neq: (col: string, val: unknown) => {
      filtered = filtered.filter((r) => r[col] !== val);
      return chain;
    },
    in: (col: string, vals: unknown[]) => {
      filtered = filtered.filter((r) => vals.includes(r[col]));
      return chain;
    },
    order: () => chain,
    maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
    then: (resolve: (v: { data: T[]; error: null }) => void) =>
      resolve({ data: filtered, error: null }),
  };
  return chain;
}

function makeDb(tables: Record<string, Record<string, unknown>[]>) {
  return {
    from: (table: string) => {
      if (!(table in tables)) throw new Error(`unexpected table in fake db: ${table}`);
      return makeQueryChain(tables[table]);
    },
  } as unknown as SupabaseClient;
}

const account = {
  id: 'acc-1',
  name: 'Pizzaria do João',
  default_currency: 'BRL',
  enabled_modules: ['delivery'],
  slug: 'pizzaria-do-joao',
};

describe('resolveAccountBySlug', () => {
  it('resolves an account with delivery enabled', async () => {
    const db = makeDb({ accounts: [account] });
    const result = await resolveAccountBySlug(db, 'pizzaria-do-joao');
    expect(result).toEqual({ id: 'acc-1', name: 'Pizzaria do João', currency: 'BRL' });
  });

  it('returns null for an unknown slug', async () => {
    const db = makeDb({ accounts: [account] });
    expect(await resolveAccountBySlug(db, 'unknown-slug')).toBeNull();
  });

  it('returns null when the account has not enabled the delivery module', async () => {
    const db = makeDb({
      accounts: [{ ...account, enabled_modules: [] }],
    });
    expect(await resolveAccountBySlug(db, 'pizzaria-do-joao')).toBeNull();
  });
});

describe('isSlugAvailable', () => {
  const accounts = [account, { ...account, id: 'acc-2', slug: 'taken-slug' }];

  it('is false when another account already has the slug', async () => {
    const db = makeDb({ accounts });
    expect(await isSlugAvailable(db, 'taken-slug')).toBe(false);
  });

  it('is true when excluding the account that already owns the slug', async () => {
    const db = makeDb({ accounts });
    expect(await isSlugAvailable(db, 'taken-slug', 'acc-2')).toBe(true);
  });

  it('is true for a slug nobody has', async () => {
    const db = makeDb({ accounts });
    expect(await isSlugAvailable(db, 'brand-new-slug')).toBe(true);
  });
});

describe('loadPublicMenu', () => {
  const tables = {
    delivery_categories: [
      { id: 'cat-1', account_id: 'acc-1', name: 'Pizzas', position: 0, is_active: true },
      { id: 'cat-2', account_id: 'acc-1', name: 'Descontinuado', position: 1, is_active: false },
    ],
    delivery_products: [
      {
        id: 'p1',
        account_id: 'acc-1',
        category_id: 'cat-1',
        name: 'Margherita',
        description: 'Molho e queijo',
        price: 45,
        image_url: null,
        position: 0,
        is_active: true,
      },
      {
        id: 'p2',
        account_id: 'acc-1',
        category_id: 'cat-1',
        name: '86ed item',
        description: null,
        price: 20,
        image_url: null,
        position: 1,
        is_active: false,
      },
      {
        id: 'p3',
        account_id: 'acc-1',
        category_id: null,
        name: 'Refrigerante',
        description: null,
        price: 8,
        image_url: null,
        position: 0,
        is_active: true,
      },
    ],
    delivery_addon_groups: [
      {
        id: 'g1',
        product_id: 'p1',
        name: 'Tamanho',
        selection_type: 'single',
        is_required: true,
        min_select: 1,
        max_select: 1,
      },
    ],
    delivery_addon_options: [
      { id: 'o1', group_id: 'g1', name: 'Grande', price_delta: 8, is_active: true },
      { id: 'o2', group_id: 'g1', name: 'Descontinuada', price_delta: 0, is_active: false },
    ],
  };

  it('groups active products under their active categories, with addon groups/options attached', async () => {
    const db = makeDb(tables);
    const { categories, uncategorizedProducts } = await loadPublicMenu(db, 'acc-1');

    expect(categories).toHaveLength(1);
    expect(categories[0].id).toBe('cat-1');
    expect(categories[0].products).toHaveLength(1);
    const product = categories[0].products[0];
    expect(product.id).toBe('p1');
    expect(product.addon_groups).toHaveLength(1);
    expect(product.addon_groups[0].options).toEqual([
      { id: 'o1', name: 'Grande', price_delta: 8 },
    ]);

    expect(uncategorizedProducts).toHaveLength(1);
    expect(uncategorizedProducts[0].id).toBe('p3');
  });

  it('excludes inactive categories, products, and addon options', async () => {
    const db = makeDb(tables);
    const { categories } = await loadPublicMenu(db, 'acc-1');
    const categoryIds = categories.map((c) => c.id);
    expect(categoryIds).not.toContain('cat-2');

    const productIds = categories.flatMap((c) => c.products.map((p) => p.id));
    expect(productIds).not.toContain('p2');

    const optionIds = categories
      .flatMap((c) => c.products)
      .flatMap((p) => p.addon_groups)
      .flatMap((g) => g.options)
      .map((o) => o.id);
    expect(optionIds).not.toContain('o2');
  });
});
