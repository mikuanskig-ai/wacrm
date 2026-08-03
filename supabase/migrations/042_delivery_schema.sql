-- ============================================================
-- 042_delivery_schema.sql — Zontalk Delivery module (Fase 1: Core).
--
-- Cardápio (categorias/produtos/adicionais) + Pedidos (orders/items).
-- Gated behind the `delivery` entry in accounts.enabled_modules
-- (migration 041) — this migration just creates the schema; the app
-- layer decides who gets to see it.
--
-- account_id is denormalized on every table (see ai_knowledge_chunks,
-- migration 030) so every RLS policy is a flat is_account_member()
-- check with no join, even 3 levels deep (option -> group -> product).
--
-- Status ladder is deliberately payment-agnostic. Mercado Pago /
-- payment states (pending_payment, payment_approved, ...) are a later
-- migration's ADD to the CHECK list + a nullable payment_status
-- column — nothing here encodes "confirmed implies paid".
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- CATEGORIES
-- ============================================================
CREATE TABLE IF NOT EXISTS delivery_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_delivery_categories_account ON delivery_categories(account_id);

ALTER TABLE delivery_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS delivery_categories_select ON delivery_categories;
DROP POLICY IF EXISTS delivery_categories_insert ON delivery_categories;
DROP POLICY IF EXISTS delivery_categories_update ON delivery_categories;
DROP POLICY IF EXISTS delivery_categories_delete ON delivery_categories;
CREATE POLICY delivery_categories_select ON delivery_categories FOR SELECT USING (is_account_member(account_id));
CREATE POLICY delivery_categories_insert ON delivery_categories FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY delivery_categories_update ON delivery_categories FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY delivery_categories_delete ON delivery_categories FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON delivery_categories;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON delivery_categories
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- PRODUCTS
-- ============================================================
CREATE TABLE IF NOT EXISTS delivery_products (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- SET NULL (not CASCADE): deleting a category shouldn't delete its
  -- products — they fall back to "uncategorized" and stay editable.
  category_id  UUID REFERENCES delivery_categories(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  price        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  image_url    TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT true, -- "86" an item without deleting it
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_delivery_products_account  ON delivery_products(account_id);
CREATE INDEX IF NOT EXISTS idx_delivery_products_category ON delivery_products(category_id);

ALTER TABLE delivery_products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS delivery_products_select ON delivery_products;
DROP POLICY IF EXISTS delivery_products_insert ON delivery_products;
DROP POLICY IF EXISTS delivery_products_update ON delivery_products;
DROP POLICY IF EXISTS delivery_products_delete ON delivery_products;
CREATE POLICY delivery_products_select ON delivery_products FOR SELECT USING (is_account_member(account_id));
CREATE POLICY delivery_products_insert ON delivery_products FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY delivery_products_update ON delivery_products FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY delivery_products_delete ON delivery_products FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON delivery_products;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON delivery_products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- ADDON GROUPS ("Tamanho", "Adicionais") — product-scoped
-- ============================================================
CREATE TABLE IF NOT EXISTS delivery_addon_groups (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  product_id      UUID NOT NULL REFERENCES delivery_products(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  selection_type  TEXT NOT NULL DEFAULT 'single' CHECK (selection_type IN ('single', 'multiple')),
  is_required     BOOLEAN NOT NULL DEFAULT false,
  min_select      INTEGER NOT NULL DEFAULT 0 CHECK (min_select >= 0),
  max_select      INTEGER CHECK (max_select IS NULL OR max_select >= min_select),
  position        INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_delivery_addon_groups_account ON delivery_addon_groups(account_id);
CREATE INDEX IF NOT EXISTS idx_delivery_addon_groups_product ON delivery_addon_groups(product_id);

ALTER TABLE delivery_addon_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS delivery_addon_groups_select ON delivery_addon_groups;
DROP POLICY IF EXISTS delivery_addon_groups_insert ON delivery_addon_groups;
DROP POLICY IF EXISTS delivery_addon_groups_update ON delivery_addon_groups;
DROP POLICY IF EXISTS delivery_addon_groups_delete ON delivery_addon_groups;
CREATE POLICY delivery_addon_groups_select ON delivery_addon_groups FOR SELECT USING (is_account_member(account_id));
CREATE POLICY delivery_addon_groups_insert ON delivery_addon_groups FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY delivery_addon_groups_update ON delivery_addon_groups FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY delivery_addon_groups_delete ON delivery_addon_groups FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- ADDON OPTIONS ("Grande +R$5", "Sem cebola")
-- ============================================================
CREATE TABLE IF NOT EXISTS delivery_addon_options (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  group_id     UUID NOT NULL REFERENCES delivery_addon_groups(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  -- No sign constraint: most options are positive add-ons, but a
  -- discount-flavored option ("sem carne -R$3") is legitimate.
  price_delta  NUMERIC(12,2) NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_delivery_addon_options_account ON delivery_addon_options(account_id);
CREATE INDEX IF NOT EXISTS idx_delivery_addon_options_group   ON delivery_addon_options(group_id);

ALTER TABLE delivery_addon_options ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS delivery_addon_options_select ON delivery_addon_options;
DROP POLICY IF EXISTS delivery_addon_options_insert ON delivery_addon_options;
DROP POLICY IF EXISTS delivery_addon_options_update ON delivery_addon_options;
DROP POLICY IF EXISTS delivery_addon_options_delete ON delivery_addon_options;
CREATE POLICY delivery_addon_options_select ON delivery_addon_options FOR SELECT USING (is_account_member(account_id));
CREATE POLICY delivery_addon_options_insert ON delivery_addon_options FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY delivery_addon_options_update ON delivery_addon_options FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY delivery_addon_options_delete ON delivery_addon_options FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- ORDERS
-- ============================================================
CREATE TABLE IF NOT EXISTS delivery_orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- SET NULL mirrors deals.contact_id (migration 004): order history
  -- survives contact deletion.
  contact_id        UUID REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id   UUID REFERENCES conversations(id) ON DELETE SET NULL,
  -- Author / audit only, never used for tenancy isolation (same split
  -- as every other table since migration 017).
  user_id           UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'pending_confirmation' CHECK (status IN (
                       'draft', 'pending_confirmation', 'confirmed',
                       'in_production', 'ready', 'out_for_delivery',
                       'delivered', 'cancelled'
                     )),
  source            TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'whatsapp_flow')),
  -- Which flow run produced this order, when source = 'whatsapp_flow'.
  -- SET NULL: flow_run history can be pruned without breaking the order.
  flow_run_id       UUID REFERENCES flow_runs(id) ON DELETE SET NULL,
  customer_name     TEXT,
  delivery_address  TEXT,
  notes             TEXT,
  subtotal          NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  -- Nullable + no default fee calc in this pass (Fase 4/Checkout
  -- territory, explicitly deferred). A flat manual fee is fine.
  delivery_fee      NUMERIC(12,2) CHECK (delivery_fee IS NULL OR delivery_fee >= 0),
  total             NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  currency          TEXT NOT NULL DEFAULT 'USD',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_delivery_orders_account        ON delivery_orders(account_id);
CREATE INDEX IF NOT EXISTS idx_delivery_orders_contact        ON delivery_orders(contact_id);
CREATE INDEX IF NOT EXISTS idx_delivery_orders_conversation   ON delivery_orders(conversation_id);
CREATE INDEX IF NOT EXISTS idx_delivery_orders_account_status ON delivery_orders(account_id, status);

ALTER TABLE delivery_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS delivery_orders_select ON delivery_orders;
DROP POLICY IF EXISTS delivery_orders_insert ON delivery_orders;
DROP POLICY IF EXISTS delivery_orders_update ON delivery_orders;
DROP POLICY IF EXISTS delivery_orders_delete ON delivery_orders;
CREATE POLICY delivery_orders_select ON delivery_orders FOR SELECT USING (is_account_member(account_id));
CREATE POLICY delivery_orders_insert ON delivery_orders FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY delivery_orders_update ON delivery_orders FOR UPDATE USING (is_account_member(account_id, 'agent'));
CREATE POLICY delivery_orders_delete ON delivery_orders FOR DELETE USING (is_account_member(account_id, 'agent'));
-- Service-role (flow engine) bypasses RLS entirely, same as flow_runs.

DROP TRIGGER IF EXISTS set_updated_at ON delivery_orders;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON delivery_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- ORDER ITEMS — addons_snapshot follows the messages.interactive_payload
-- / quick_replies.interactive_payload JSONB-snapshot precedent
-- (migration 035): order history must survive addon edits/deletes.
-- ============================================================
CREATE TABLE IF NOT EXISTS delivery_order_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  order_id         UUID NOT NULL REFERENCES delivery_orders(id) ON DELETE CASCADE,
  -- SET NULL: product can be deleted/renamed later; product_name/
  -- unit_price below are the frozen-at-order-time snapshot.
  product_id       UUID REFERENCES delivery_products(id) ON DELETE SET NULL,
  product_name     TEXT NOT NULL,
  unit_price       NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  quantity         INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  -- Array of { group_id, group_name, option_id, option_name, price_delta }.
  addons_snapshot  JSONB NOT NULL DEFAULT '[]'::jsonb,
  line_total       NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (line_total >= 0),
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_delivery_order_items_account ON delivery_order_items(account_id);
CREATE INDEX IF NOT EXISTS idx_delivery_order_items_order   ON delivery_order_items(order_id);

ALTER TABLE delivery_order_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS delivery_order_items_select ON delivery_order_items;
DROP POLICY IF EXISTS delivery_order_items_insert ON delivery_order_items;
DROP POLICY IF EXISTS delivery_order_items_update ON delivery_order_items;
DROP POLICY IF EXISTS delivery_order_items_delete ON delivery_order_items;
CREATE POLICY delivery_order_items_select ON delivery_order_items FOR SELECT USING (is_account_member(account_id));
CREATE POLICY delivery_order_items_insert ON delivery_order_items FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY delivery_order_items_update ON delivery_order_items FOR UPDATE USING (is_account_member(account_id, 'agent'));
CREATE POLICY delivery_order_items_delete ON delivery_order_items FOR DELETE USING (is_account_member(account_id, 'agent'));
