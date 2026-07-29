import type { CartEntry } from './types';

/**
 * Cart lives in localStorage, keyed per store slug — not
 * conversations.ai_cart (that mechanism is WhatsApp-conversation
 * scoped and doesn't apply to an anonymous web visitor). Survives a
 * refresh; never sent anywhere until checkout.
 */
function storageKey(slug: string): string {
  return `zontalk-public-cart:${slug}`;
}

export function loadCart(slug: string): CartEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(storageKey(slug));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CartEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveCart(slug: string, cart: CartEntry[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(slug), JSON.stringify(cart));
  } catch {
    // Storage full/blocked (private browsing) — cart just won't
    // survive a refresh, not worth surfacing an error for.
  }
}

export function clearCart(slug: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(storageKey(slug));
}
