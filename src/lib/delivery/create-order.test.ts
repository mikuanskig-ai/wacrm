import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/webhooks/deliver", () => ({
  dispatchWebhookEvent: vi.fn(async () => {}),
}));
vi.mock("@/lib/automations/engine", () => ({
  runAutomationsForTrigger: vi.fn(async () => {}),
}));
vi.mock("@/lib/payments/config", () => ({
  getPaymentConfigSecrets: vi.fn(),
}));
vi.mock("@/lib/payments/mercadopago-api", () => ({
  createPreference: vi.fn(),
}));
vi.mock("@/lib/whatsapp/send-message", () => ({
  sendMessageToConversation: vi.fn(async () => ({ messageId: "m1" })),
}));

import { computeCartTotal, finalizeDeliveryOrder, type CartLineItem } from "./create-order";
import { getPaymentConfigSecrets } from "@/lib/payments/config";
import { createPreference } from "@/lib/payments/mercadopago-api";
import { sendMessageToConversation } from "@/lib/whatsapp/send-message";

function line(overrides: Partial<CartLineItem> = {}): CartLineItem {
  return {
    product_id: "p1",
    product_name: "Pizza",
    unit_price: 20,
    quantity: 1,
    addons: [],
    ...overrides,
  };
}

describe("computeCartTotal", () => {
  it("returns zero subtotal for an empty cart", () => {
    expect(computeCartTotal([])).toEqual({ subtotal: 0 });
  });

  it("multiplies unit_price by quantity", () => {
    expect(computeCartTotal([line({ unit_price: 15, quantity: 3 })])).toEqual({
      subtotal: 45,
    });
  });

  it("adds addon price_deltas before multiplying by quantity", () => {
    const item = line({
      unit_price: 20,
      quantity: 2,
      addons: [
        { group_id: "g1", group_name: "Size", option_id: "o1", option_name: "Large", price_delta: 5 },
        { group_id: "g2", group_name: "Extras", option_id: "o2", option_name: "Cheese", price_delta: 2 },
      ],
    });
    // (20 + 5 + 2) * 2 = 54
    expect(computeCartTotal([item])).toEqual({ subtotal: 54 });
  });

  it("supports a negative price_delta (discount-flavored option)", () => {
    const item = line({
      unit_price: 20,
      quantity: 1,
      addons: [
        { group_id: "g1", group_name: "Extras", option_id: "o1", option_name: "No meat", price_delta: -3 },
      ],
    });
    expect(computeCartTotal([item])).toEqual({ subtotal: 17 });
  });

  it("sums multiple cart lines", () => {
    const cart = [
      line({ unit_price: 20, quantity: 1 }),
      line({ product_id: "p2", product_name: "Soda", unit_price: 5, quantity: 2 }),
    ];
    // 20 + (5*2) = 30
    expect(computeCartTotal(cart)).toEqual({ subtotal: 30 });
  });

  it("rounds to the nearest cent to avoid float drift", () => {
    const item = line({ unit_price: 0.1, quantity: 3 });
    // 0.1 * 3 = 0.30000000000000004 in raw float arithmetic
    expect(computeCartTotal([item])).toEqual({ subtotal: 0.3 });
  });
});

// Fase 4 (Checkout) — Mercado Pago preference creation inside
// finalizeDeliveryOrder. Only delivery_orders / delivery_order_items
// need a real (faked) db; everything else (payment config lookup,
// the MP API call, outbound WhatsApp send, webhook dispatch,
// automations) is module-mocked above so these tests stay focused on
// finalizeDeliveryOrder's own branching.
function makeOrdersDb(args: {
  baseOrder: Record<string, unknown>;
  updatePayload?: Record<string, unknown>;
}) {
  const updateCalls: Record<string, unknown>[] = [];
  const insertCalls: Record<string, unknown>[] = [];
  const db = {
    from(table: string) {
      if (table === "delivery_orders") {
        let mode: "insert" | "update" = "insert";
        const builder: Record<string, unknown> = {
          insert: (payload: Record<string, unknown>) => {
            mode = "insert";
            insertCalls.push(payload);
            return builder;
          },
          update: (payload: Record<string, unknown>) => {
            mode = "update";
            updateCalls.push(payload);
            return builder;
          },
          eq: () => builder,
          select: () => builder,
          single: () =>
            Promise.resolve(
              mode === "insert"
                ? { data: args.baseOrder, error: null }
                : { data: { ...args.baseOrder, ...args.updatePayload }, error: null },
            ),
        };
        return builder;
      }
      if (table === "delivery_order_items") {
        return { insert: () => Promise.resolve({ error: null }) };
      }
      throw new Error(`unexpected table in test fake db: ${table}`);
    },
  };
  return { db: db as unknown as SupabaseClient, updateCalls, insertCalls };
}

const BASE_ORDER = {
  id: "order-1",
  account_id: "acct-1",
  contact_id: "contact-1",
  conversation_id: null as string | null,
  status: "pending_confirmation",
  source: "manual" as const,
  customer_name: "Ana",
  total: 40,
  currency: "BRL",
  payment_status: null as string | null,
  checkout_url: null as string | null,
};

const CART: CartLineItem[] = [
  { product_id: "p1", product_name: "Pizza", unit_price: 40, quantity: 1, addons: [] },
];

describe("finalizeDeliveryOrder — Mercado Pago checkout (Fase 4)", () => {
  beforeEach(() => {
    vi.mocked(getPaymentConfigSecrets).mockReset();
    vi.mocked(createPreference).mockReset();
    vi.mocked(sendMessageToConversation).mockClear();
  });

  it("creates a preference and merges payment fields onto the order when payment is enabled", async () => {
    vi.mocked(getPaymentConfigSecrets).mockResolvedValue({
      enabled: true,
      mpAccessToken: "token",
      mpWebhookSecret: "secret",
    });
    vi.mocked(createPreference).mockResolvedValue({
      preferenceId: "pref-1",
      initPoint: "https://mp.example/checkout/pref-1",
    });

    const { db } = makeOrdersDb({
      baseOrder: { ...BASE_ORDER, conversation_id: "conv-1" },
      updatePayload: {
        payment_status: "pending_payment",
        mp_preference_id: "pref-1",
        checkout_url: "https://mp.example/checkout/pref-1",
      },
    });

    const order = await finalizeDeliveryOrder(db, {
      accountId: "acct-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      source: "manual",
      cart: CART,
      currency: "BRL",
    });

    expect(order.payment_status).toBe("pending_payment");
    expect(order.checkout_url).toBe("https://mp.example/checkout/pref-1");
    expect(sendMessageToConversation).toHaveBeenCalledTimes(1);
    expect(sendMessageToConversation).toHaveBeenCalledWith(
      db,
      "acct-1",
      expect.objectContaining({
        conversationId: "conv-1",
        messageType: "text",
        contentText: expect.stringContaining("https://mp.example/checkout/pref-1"),
      }),
    );
  });

  it("leaves payment_status null and still creates the order when the Mercado Pago call fails", async () => {
    vi.mocked(getPaymentConfigSecrets).mockResolvedValue({
      enabled: true,
      mpAccessToken: "token",
      mpWebhookSecret: "secret",
    });
    vi.mocked(createPreference).mockRejectedValue(new Error("Mercado Pago error: 401"));

    const { db } = makeOrdersDb({ baseOrder: { ...BASE_ORDER, conversation_id: "conv-1" } });

    const order = await finalizeDeliveryOrder(db, {
      accountId: "acct-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      source: "manual",
      cart: CART,
      currency: "BRL",
    });

    expect(order.payment_status).toBeNull();
    expect(sendMessageToConversation).not.toHaveBeenCalled();
  });

  it("does not attempt a preference or send a message when payment is not enabled", async () => {
    vi.mocked(getPaymentConfigSecrets).mockResolvedValue(null);

    const { db } = makeOrdersDb({ baseOrder: { ...BASE_ORDER, conversation_id: "conv-1" } });

    const order = await finalizeDeliveryOrder(db, {
      accountId: "acct-1",
      contactId: "contact-1",
      conversationId: "conv-1",
      source: "manual",
      cart: CART,
      currency: "BRL",
    });

    expect(order.payment_status).toBeNull();
    expect(createPreference).not.toHaveBeenCalled();
    expect(sendMessageToConversation).not.toHaveBeenCalled();
  });

  it("does not send a payment link message when the order has no conversation_id", async () => {
    vi.mocked(getPaymentConfigSecrets).mockResolvedValue({
      enabled: true,
      mpAccessToken: "token",
      mpWebhookSecret: "secret",
    });
    vi.mocked(createPreference).mockResolvedValue({
      preferenceId: "pref-1",
      initPoint: "https://mp.example/checkout/pref-1",
    });

    const { db } = makeOrdersDb({
      baseOrder: { ...BASE_ORDER, conversation_id: null },
      updatePayload: {
        payment_status: "pending_payment",
        mp_preference_id: "pref-1",
        checkout_url: "https://mp.example/checkout/pref-1",
      },
    });

    const order = await finalizeDeliveryOrder(db, {
      accountId: "acct-1",
      contactId: "contact-1",
      conversationId: null,
      source: "manual",
      cart: CART,
      currency: "BRL",
    });

    expect(order.payment_status).toBe("pending_payment");
    expect(sendMessageToConversation).not.toHaveBeenCalled();
  });
});

describe("finalizeDeliveryOrder — payment method", () => {
  beforeEach(() => {
    vi.mocked(getPaymentConfigSecrets).mockReset();
    vi.mocked(getPaymentConfigSecrets).mockResolvedValue(null);
  });

  it("passes paymentMethod/paymentNotes through to the insert", async () => {
    const { db, insertCalls } = makeOrdersDb({ baseOrder: BASE_ORDER });

    await finalizeDeliveryOrder(db, {
      accountId: "acct-1",
      contactId: "contact-1",
      conversationId: null,
      source: "ai_chat",
      cart: CART,
      currency: "BRL",
      paymentMethod: "pix",
      paymentNotes: "troco para R$100",
    });

    expect(insertCalls[0]).toEqual(
      expect.objectContaining({
        payment_method: "pix",
        payment_notes: "troco para R$100",
      }),
    );
  });

  it("defaults payment_method/payment_notes to null when not given", async () => {
    const { db, insertCalls } = makeOrdersDb({ baseOrder: BASE_ORDER });

    await finalizeDeliveryOrder(db, {
      accountId: "acct-1",
      contactId: "contact-1",
      conversationId: null,
      source: "manual",
      cart: CART,
      currency: "BRL",
    });

    expect(insertCalls[0]).toEqual(
      expect.objectContaining({ payment_method: null, payment_notes: null }),
    );
  });
});
