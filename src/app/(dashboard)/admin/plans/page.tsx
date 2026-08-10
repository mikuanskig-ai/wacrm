"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Planos moved from its own route into a tab of `/admin` (Fase 3 of the
 *  platform admin expansion) — this keeps any old bookmark/link working. */
export default function LegacyAdminPlansRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/admin?tab=plans");
  }, [router]);
  return null;
}
