// ============================================================
// /pricing layout — sits outside both `(auth)` and `(dashboard)`.
//
// Same reasoning as src/app/join/layout.tsx: this page is hybrid (an
// anonymous visitor picking a plan before signup, or a signed-in
// tenant checking what a plan includes later) — reusing `(auth)`
// would funnel a signed-in visitor through the middleware's auth-page
// redirect, reusing `(dashboard)` would funnel an anonymous visitor
// through its login redirect.
//
// Unlike `(auth)` (which sets `robots: noindex` for the whole group —
// login/signup/forgot-password shouldn't compete with the marketing
// landing in search results), /pricing is the one page in this funnel
// that SHOULD be indexed.
// ============================================================

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  robots: { index: true, follow: true },
};

export default function PricingLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-background">{children}</div>;
}
