-- ============================================================
-- 043_delivery_media_bucket.sql — `delivery-media` Storage bucket for
-- product photos in the Delivery module (migration 042).
--
-- Mirrors `chat-media` (migration 023) exactly, minus everything not
-- relevant to a product photo: images only, 5 MB cap (product photos
-- don't need Meta's 16 MB video allowance).
--
-- Idempotent — safe to re-run.
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'delivery-media',
  'delivery-media',
  TRUE,
  5242880, -- 5 MB
  ARRAY['image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Delivery media is publicly readable" ON storage.objects;
CREATE POLICY "Delivery media is publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'delivery-media');

DROP POLICY IF EXISTS "Members can upload delivery media" ON storage.objects;
CREATE POLICY "Members can upload delivery media"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'delivery-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can update delivery media" ON storage.objects;
CREATE POLICY "Members can update delivery media"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'delivery-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can delete delivery media" ON storage.objects;
CREATE POLICY "Members can delete delivery media"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'delivery-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );
