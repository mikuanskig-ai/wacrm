"use client";

/**
 * "Simular" panel — a sandbox chat that walks the CURRENT (possibly
 * unsaved) node graph via src/lib/flows/simulate.ts, never touching
 * Supabase writes, Meta sends, or real order creation. Same reasoning
 * as the AI Agents Playground: testing a flow shouldn't require
 * saving/activating it first, and shouldn't risk a real customer
 * seeing a half-built flow.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Loader2,
  RotateCcw,
  Send,
  Tag as TagIcon,
  TestTube2,
  UserCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useFlowEditor } from "./flow-editor-state";
import {
  advance,
  reply as replyToNode,
  createInitialState,
  type SimState,
  type SimMessage,
  type SimNode,
  type SimProduct,
} from "@/lib/flows/simulate";

interface FlowSimulatorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface TagOption {
  id: string;
  name: string;
  color: string;
}

export function FlowSimulator({ open, onOpenChange }: FlowSimulatorProps) {
  const { accountId } = useAuth();
  const { state: flow } = useFlowEditor();

  const [tags, setTags] = useState<TagOption[]>([]);
  const [catalog, setCatalog] = useState<SimProduct[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);

  const [contactName, setContactName] = useState("Cliente Teste");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactCompany, setContactCompany] = useState("");
  const [preTagIds, setPreTagIds] = useState<string[]>([]);

  const [messages, setMessages] = useState<SimMessage[]>([]);
  const [simState, setSimState] = useState<SimState | null>(null);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const nodesByKey = useMemo(() => {
    const map = new Map<string, SimNode>();
    for (const n of flow.nodes) {
      map.set(n.node_key, { node_key: n.node_key, node_type: n.node_type, config: n.config });
    }
    return map;
  }, [flow.nodes]);

  const tagNamesById = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tags) map.set(t.id, t.name);
    return map;
  }, [tags]);

  const needsCatalog = useMemo(
    () => flow.nodes.some((n) => n.node_type === "add_order_item"),
    [flow.nodes],
  );

  // Tags for the pre-existing-tags picker (tag-condition testing) and
  // for rendering readable names when set_tag fires during the run.
  useEffect(() => {
    if (!open || !accountId) return;
    let cancelled = false;
    const supabase = createClient();
    supabase
      .from("tags")
      .select("id, name, color")
      .order("name")
      .then(({ data }) => {
        if (!cancelled && data) setTags(data as TagOption[]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, accountId]);

  // Delivery catalog — only fetched if the flow actually has an
  // add_order_item node, and only once per sheet session.
  useEffect(() => {
    if (!open || !needsCatalog || catalog.length > 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kicks off the async load, settled inside the async IIFE below
    setCatalogLoading(true);
    const supabase = createClient();
    (async () => {
      const { data: products } = await supabase
        .from("delivery_products")
        .select("id, name, price, category_id")
        .eq("is_active", true)
        .order("position");
      const productRows = (products ?? []) as {
        id: string;
        name: string;
        price: number;
        category_id: string | null;
      }[];
      if (productRows.length === 0) {
        setCatalog([]);
        setCatalogLoading(false);
        return;
      }
      const { data: groups } = await supabase
        .from("delivery_addon_groups")
        .select("id, name, selection_type, is_required, position, product_id")
        .in(
          "product_id",
          productRows.map((p) => p.id),
        )
        .order("position");
      const groupRows = (groups ?? []) as {
        id: string;
        name: string;
        selection_type: "single" | "multiple";
        is_required: boolean;
        product_id: string;
      }[];
      let optionRows: { id: string; name: string; price_delta: number; group_id: string }[] = [];
      if (groupRows.length > 0) {
        const { data: opts } = await supabase
          .from("delivery_addon_options")
          .select("id, name, price_delta, group_id")
          .in(
            "group_id",
            groupRows.map((g) => g.id),
          )
          .eq("is_active", true)
          .order("position");
        optionRows = opts ?? [];
      }
      setCatalog(
        productRows.map((p) => ({
          id: p.id,
          name: p.name,
          price: p.price,
          category_id: p.category_id,
          addon_groups: groupRows
            .filter((g) => g.product_id === p.id)
            .map((g) => ({
              id: g.id,
              name: g.name,
              selection_type: g.selection_type,
              is_required: g.is_required,
              options: optionRows
                .filter((o) => o.group_id === g.id)
                .map((o) => ({ id: o.id, name: o.name, price_delta: o.price_delta })),
            })),
        })),
      );
      setCatalogLoading(false);
    })();
  }, [open, needsCatalog, catalog.length]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  function reset() {
    setMessages([]);
    setSimState(null);
    setInput("");
  }

  function handleStart() {
    if (!flow.entry_node_id) return;
    const initial = createInitialState({
      name: contactName.trim() || undefined,
      email: contactEmail.trim() || undefined,
      phone: contactPhone.trim() || undefined,
      company: contactCompany.trim() || undefined,
    });
    initial.tagIds = new Set(preTagIds);
    const result = advance(nodesByKey, flow.entry_node_id, initial, catalog, tagNamesById);
    setSimState(result.state);
    setMessages(result.messages);
  }

  function handleSend() {
    const text = input.trim();
    if (!text || !simState) return;
    setInput("");
    const userMsg: SimMessage = { from: "system", text: `👤 ${text}` };
    const result = replyToNode(nodesByKey, simState, text, catalog, tagNamesById);
    setSimState(result.state);
    setMessages((prev) => [...prev, userMsg, ...result.messages]);
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSend();
    }
  };

  const running = simState?.status === "running";
  const ended = simState?.status === "ended" || simState?.status === "handed_off";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b border-border px-5 py-4">
          <SheetTitle className="flex items-center gap-2">
            <TestTube2 className="h-4 w-4 text-primary" /> Simular fluxo
          </SheetTitle>
          <SheetDescription>
            Testa a lógica do fluxo (mensagens, condições, tags, cardápio) sem
            enviar nada de verdade pelo WhatsApp e sem criar pedidos reais.
            Usa as alterações ainda não salvas.
          </SheetDescription>
        </SheetHeader>

        {!simState ? (
          <div className="flex-1 space-y-4 overflow-y-auto p-5">
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Contato simulado
              </h4>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  value={contactName}
                  onChange={(e) => setContactName(e.target.value)}
                  placeholder="Nome"
                />
                <Input
                  value={contactCompany}
                  onChange={(e) => setContactCompany(e.target.value)}
                  placeholder="Empresa"
                />
                <Input
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                  placeholder="E-mail"
                />
                <Input
                  value={contactPhone}
                  onChange={(e) => setContactPhone(e.target.value)}
                  placeholder="Telefone"
                />
              </div>
            </div>

            {tags.length > 0 && (
              <div>
                <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <TagIcon className="h-3 w-3" /> Tags que o contato já teria
                </h4>
                <div className="flex flex-wrap gap-1.5">
                  {tags.map((tag) => {
                    const selected = preTagIds.includes(tag.id);
                    return (
                      <button
                        key={tag.id}
                        type="button"
                        onClick={() =>
                          setPreTagIds((prev) =>
                            selected ? prev.filter((id) => id !== tag.id) : [...prev, tag.id],
                          )
                        }
                        className={cn(
                          "rounded-full px-2 py-1 text-xs font-medium transition-opacity",
                          selected ? "ring-2 ring-primary ring-offset-1 ring-offset-popover" : "opacity-50 hover:opacity-80",
                        )}
                        style={{ backgroundColor: `${tag.color}20`, color: tag.color }}
                      >
                        {tag.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {needsCatalog && catalogLoading && (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Carregando cardápio para simular o pedido…
              </p>
            )}

            {!flow.entry_node_id && (
              <p className="text-xs text-destructive">
                Este fluxo ainda não tem um nó de entrada definido.
              </p>
            )}

            <Button onClick={handleStart} disabled={!flow.entry_node_id} className="w-full">
              Iniciar simulação
            </Button>
          </div>
        ) : (
          <>
            <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
              {messages.map((m, i) => (
                <SimBubble key={i} message={m} />
              ))}
              {ended && (
                <p className="text-center text-xs text-muted-foreground">
                  — fim da simulação —
                </p>
              )}
            </div>

            <div className="flex items-center gap-2 border-t border-border p-3">
              <Button variant="ghost" size="sm" onClick={reset} className="shrink-0 text-muted-foreground">
                <RotateCcw className="h-3.5 w-3.5" /> Reiniciar
              </Button>
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={running ? "Digite a resposta do cliente…" : "Simulação encerrada"}
                disabled={!running}
                className="flex-1"
              />
              <Button
                size="sm"
                onClick={handleSend}
                disabled={!running || !input.trim()}
                className="h-9 w-9 shrink-0 p-0"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function SimBubble({ message }: { message: SimMessage }) {
  if (message.from === "system") {
    const isCustomer = message.text.startsWith("👤 ");
    if (isCustomer) {
      return (
        <div className="flex justify-end gap-2">
          <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">
            <p className="whitespace-pre-wrap">{message.text.slice(2)}</p>
          </div>
          <UserCircle2 className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" />
        </div>
      );
    }
    return (
      <p className="text-center text-xs text-muted-foreground">{message.text}</p>
    );
  }
  return (
    <div className="flex justify-start gap-2">
      <Bot className="mt-1 h-5 w-5 shrink-0 text-primary" />
      <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 text-sm text-foreground">
        <p className="whitespace-pre-wrap">{message.text}</p>
      </div>
    </div>
  );
}
