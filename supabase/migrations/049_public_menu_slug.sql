-- ============================================================
-- 049_public_menu_slug.sql — Zontalk Delivery module (Fase 6: Escala).
--
-- Public, no-login "cardápio" (menu) web page per account at
-- /c/<slug>, where a customer can browse the menu, build a cart, and
-- complete checkout (including Mercado Pago payment when enabled)
-- entirely on the web — no WhatsApp required.
--
--   - `accounts.slug` — merchant-chosen URL segment, globally unique
--     (it's a URL path, not scoped per anything). Nullable until the
--     merchant sets one in Settings; the delivery module can be
--     enabled with no slug yet, the public page is just unreachable.
--     Format/length enforced by CHECK; global uniqueness by a partial
--     unique index (ignores NULLs, so many accounts can simultaneously
--     have no slug set). No RLS change needed — the existing
--     `accounts_update` policy (migration 017) already requires
--     admin+, and the public routes read via the service-role client,
--     never through RLS.
--   - `delivery_orders.source` gains a fourth value, `'public_web'`,
--     for orders placed through this new public checkout path —
--     distinguishing them from `'manual'` (staff), `'whatsapp_flow'`
--     (Fase 1), and `'ai_chat'` (Fase 2). Same drop/recreate pattern
--     migration 044 already used to add `'ai_chat'`.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS slug TEXT;

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_slug_format_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_slug_format_check
  CHECK (slug IS NULL OR slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_slug_length_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_slug_length_check
  CHECK (slug IS NULL OR char_length(slug) BETWEEN 3 AND 60);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_slug ON accounts(slug) WHERE slug IS NOT NULL;

COMMENT ON COLUMN accounts.slug IS
  'Merchant-chosen URL segment for the public /c/<slug> cardápio (Fase 6). Global uniqueness enforced by the partial unique index above (NULLs excluded).';

ALTER TABLE delivery_orders DROP CONSTRAINT IF EXISTS delivery_orders_source_check;
ALTER TABLE delivery_orders ADD CONSTRAINT delivery_orders_source_check
  CHECK (source IN ('manual', 'whatsapp_flow', 'ai_chat', 'public_web'));
