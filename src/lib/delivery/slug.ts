// ============================================================
// Public cardápio slug — pure format validation + a best-effort
// suggestion generator. Mirrors the CHECK constraints added on
// `accounts.slug` in migration 049: lowercase-kebab-case, 3-60 chars.
// Kept here (not inline in the API route) so the settings-panel form
// can validate as-you-type without a round trip.
// ============================================================

const SLUG_FORMAT = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SLUG_MIN_LENGTH = 3;
const SLUG_MAX_LENGTH = 60;
// Unicode combining diacritical marks block — what NFD normalization
// splits accented letters into, e.g. "a-with-tilde" -> "a" + U+0303.
const DIACRITICS = /[̀-ͯ]/g;

export function isValidSlugFormat(slug: string): boolean {
  return (
    slug.length >= SLUG_MIN_LENGTH &&
    slug.length <= SLUG_MAX_LENGTH &&
    SLUG_FORMAT.test(slug)
  );
}

/**
 * Best-effort slug suggestion from a display name — strips accents,
 * lowercases, collapses anything that isn't [a-z0-9] into a single
 * hyphen, and trims to the same bounds the CHECK constraint enforces.
 * Not guaranteed unique — the caller (settings save flow) still needs
 * to check availability.
 */
export function slugify(input: string): string {
  const normalized = input
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized.slice(0, SLUG_MAX_LENGTH).replace(/-$/, '');
}
