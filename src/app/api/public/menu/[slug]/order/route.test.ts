import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveAccountBySlug: vi.fn(),
  loadPublicMenu: vi.fn(),
  getBusinessHours: vi.fn(),
  finalizeDeliveryOrder: vi.fn(),
}));

vi.mock('@/lib/payments/admin-client', () => ({
  supabaseAdmin: () => ({}),
}));

vi.mock('@/lib/delivery/public-menu', () => ({
  resolveAccountBySlug: mocks.resolveAccountBySlug,
  loadPublicMenu: mocks.loadPublicMenu,
}));

vi.mock('@/lib/delivery/business-hours', () => ({
  getBusinessHours: mocks.getBusinessHours,
  isWithinBusinessHours: () => false,
  closedMessage: () => 'Estamos fechados no momento.',
}));

vi.mock('@/lib/delivery/create-order', () => ({
  finalizeDeliveryOrder: mocks.finalizeDeliveryOrder,
}));

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { POST } from './route';

const account = { id: 'acc-1', name: 'Pizzaria', currency: 'BRL' };

const menu = {
  categories: [
    {
      id: 'cat-1',
      name: 'Pizzas',
      position: 0,
      products: [
        {
          id: 'p1',
          name: 'Margherita',
          description: null,
          price: 45,
          image_url: null,
          position: 0,
          addon_groups: [
            {
              id: 'g1',
              name: 'Tamanho',
              selection_type: 'single' as const,
              is_required: true,
              min_select: 1,
              max_select: 1,
              options: [{ id: 'o1', name: 'Grande', price_delta: 8 }],
            },
          ],
        },
      ],
    },
  ],
  uncategorizedProducts: [],
};

function request(body: unknown) {
  return new Request('http://localhost/api/public/menu/pizzaria/order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ slug: 'pizzaria' }) };

beforeEach(() => {
  __resetRateLimitForTests();
  mocks.resolveAccountBySlug.mockReset();
  mocks.loadPublicMenu.mockReset();
  mocks.getBusinessHours.mockReset();
  mocks.finalizeDeliveryOrder.mockReset();
  mocks.resolveAccountBySlug.mockResolvedValue(account);
  mocks.loadPublicMenu.mockResolvedValue(menu);
  mocks.getBusinessHours.mockResolvedValue(null);
});

describe('POST /api/public/menu/[slug]/order', () => {
  it('returns 404 for an unknown or module-disabled slug', async () => {
    mocks.resolveAccountBySlug.mockResolvedValue(null);
    const res = await POST(request({ items: [{ product_id: 'p1', quantity: 1 }] }), params);
    expect(res.status).toBe(404);
    expect(mocks.finalizeDeliveryOrder).not.toHaveBeenCalled();
  });

  it('rejects with 409 when business hours are enabled and currently closed', async () => {
    mocks.getBusinessHours.mockResolvedValue({ enabled: true, timezone: 'UTC', hours: {} });
    const res = await POST(request({ items: [{ product_id: 'p1', quantity: 1 }] }), params);
    expect(res.status).toBe(409);
    expect(mocks.finalizeDeliveryOrder).not.toHaveBeenCalled();
  });

  it('rejects an unknown product_id with 400', async () => {
    const res = await POST(
      request({ items: [{ product_id: 'not-a-real-product', quantity: 1 }] }),
      params,
    );
    expect(res.status).toBe(400);
    expect(mocks.finalizeDeliveryOrder).not.toHaveBeenCalled();
  });

  it('ignores any client-submitted price and recomputes the cart from the DB-loaded menu', async () => {
    mocks.finalizeDeliveryOrder.mockResolvedValue({
      id: 'order-1',
      total: 53,
      currency: 'BRL',
      checkout_url: null,
    });

    const res = await POST(
      request({
        items: [
          {
            // A tampered client would send a bogus/zero price here —
            // the route must never read it.
            product_id: 'p1',
            quantity: 1,
            addon_option_ids: ['o1'],
            unit_price: 0.01,
          },
        ],
        customer_name: 'Maria',
        customer_phone: '5511999999999',
        delivery_address: 'Rua X, 123',
      }),
      params,
    );

    expect(res.status).toBe(201);
    expect(mocks.finalizeDeliveryOrder).toHaveBeenCalledTimes(1);
    const call = mocks.finalizeDeliveryOrder.mock.calls[0][1];
    expect(call.source).toBe('public_web');
    expect(call.cart).toEqual([
      {
        product_id: 'p1',
        product_name: 'Margherita',
        unit_price: 45,
        quantity: 1,
        addons: [
          {
            group_id: 'g1',
            group_name: 'Tamanho',
            option_id: 'o1',
            option_name: 'Grande',
            price_delta: 8,
          },
        ],
        notes: null,
      },
    ]);

    const body = await res.json();
    expect(body).toMatchObject({ order_id: 'order-1', total: 53, currency: 'BRL', checkout_url: null });
  });

  it('rejects an empty items array', async () => {
    const res = await POST(request({ items: [] }), params);
    expect(res.status).toBe(400);
    expect(mocks.finalizeDeliveryOrder).not.toHaveBeenCalled();
  });
});
