// Site root — the marketing landing page. Authenticated visitors never
// see this: middleware.ts redirects them to /dashboard before the
// request reaches here. Anonymous visitors get this page directly, no
// redirect at all (unlike /pricing, there's no route-group ambiguity
// to resolve here since `/` has no siblings).
//
// robots/title are overridden here (not in a layout.tsx — this route
// has no group of its own) the same way /pricing/layout.tsx overrides
// the root layout's global `{index:false, follow:false}` default.
// `title: { absolute }` bypasses the root layout's "%s — ZonTalk"
// template so this page's <title> isn't suffixed twice (the copy
// already says "ZonTalk").
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { LandingHeader } from "@/components/landing/landing-header";
import { HeroSection } from "@/components/landing/hero-section";
import { HowItWorksSection } from "@/components/landing/how-it-works-section";
import { FeaturesSection } from "@/components/landing/features-section";
import { PricingTeaserSection } from "@/components/landing/pricing-teaser-section";
import { FinalCtaSection } from "@/components/landing/final-cta-section";
import { LandingFooter } from "@/components/landing/landing-footer";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Landing.meta");
  return {
    title: { absolute: t("title") },
    description: t("description"),
    robots: { index: true, follow: true },
  };
}

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background">
      <LandingHeader />
      <main>
        <HeroSection />
        <HowItWorksSection />
        <FeaturesSection />
        <PricingTeaserSection />
        <FinalCtaSection />
      </main>
      <LandingFooter />
    </div>
  );
}
