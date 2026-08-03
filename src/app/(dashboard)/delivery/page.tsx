import { redirect } from "next/navigation";

/**
 * `/delivery` used to render the menu/catalog editor directly — the
 * most common click ("go check my orders") landed on the wrong
 * sub-page every time. Pedidos is the operational home now; the
 * catalog lives at /delivery/cardapio (see sidebar.tsx + UX audit
 * Parte 2).
 */
export default function DeliveryRootPage() {
  redirect("/delivery/pedidos");
}
