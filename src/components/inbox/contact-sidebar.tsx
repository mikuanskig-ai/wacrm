"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { hasModule } from "@/lib/accounts/modules";
import { formatCurrency } from "@/lib/currency";
import { addContactTag, deleteContactTag } from "@/lib/contacts/tag-api";
import type { Contact, Deal, DeliveryOrder, ContactNote, Tag, Pipeline, PipelineStage } from "@/types";
import {
  Phone,
  Mail,
  Copy,
  Check,
  User,
  Pencil,
  Tag as TagIcon,
  DollarSign,
  StickyNote,
  Plus,
  UtensilsCrossed,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DeliveryOrderMiniCard } from "@/components/delivery/delivery-order-mini-card";
import { format } from "date-fns";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

interface ContactSidebarProps {
  contact: Contact | null;
  /** Called after a successful inline edit so the parent's own contact
   *  snapshot (thread header avatar/name, etc.) stays in sync without
   *  waiting for the next conversation-list resync. */
  onContactUpdated?: (patch: Partial<Contact>) => void;
}

export function ContactSidebar({ contact, onContactUpdated }: ContactSidebarProps) {
  const tSidebar = useTranslations("Inbox.sidebar");
  const tThread = useTranslations("Inbox.messageThread");
  const tCommon = useTranslations("Common");

  const router = useRouter();
  const { user, accountId, account, defaultCurrency } = useAuth();
  const deliveryEnabled = hasModule(account, "delivery");
  const [copied, setCopied] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [orders, setOrders] = useState<DeliveryOrder[]>([]);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [tags, setTags] = useState<(Tag & { contact_tag_id: string })[]>([]);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  // Inline contact edit (name/email/company) — the sidebar used to be
  // read-only, forcing a trip to /contacts for even a typo fix.
  const [editingContact, setEditingContact] = useState(false);
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editCompany, setEditCompany] = useState("");
  const [savingContact, setSavingContact] = useState(false);

  // Inline "add deal" — every pipeline's stages are loaded once per
  // account (not just the ones this contact already has a deal in,
  // unlike `stagesByPipeline` below) so a brand-new deal can target any
  // pipeline. New deal always lands on that pipeline's first stage.
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [allStagesByPipeline, setAllStagesByPipeline] = useState<Record<string, PipelineStage[]>>({});
  const [addDealOpen, setAddDealOpen] = useState(false);
  const [dealTitle, setDealTitle] = useState("");
  const [dealValue, setDealValue] = useState("");
  const [dealPipelineId, setDealPipelineId] = useState("");
  const [creatingDeal, setCreatingDeal] = useState(false);

  // Inline tag-picker + deal-stage-changer state — lets an agent keep
  // both up to date without leaving the inbox for the Contacts page or
  // the pipeline board. `allTags` is every tag on the account (for the
  // add-tag popover); `stagesByPipeline` holds each open deal's
  // pipeline stages (for the inline stage dropdown), keyed by
  // pipeline_id since a contact can in principle have deals in more
  // than one pipeline.
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [savingTagId, setSavingTagId] = useState<string | null>(null);
  const [stagesByPipeline, setStagesByPipeline] = useState<Record<string, PipelineStage[]>>({});
  const [changingDealId, setChangingDealId] = useState<string | null>(null);

  const fetchContactData = useCallback(async () => {
    if (!contact) return;

    const supabase = createClient();

    // Fetch deals, orders, notes, and tags in parallel
    const [dealsRes, ordersRes, notesRes, tagsRes] = await Promise.all([
      supabase
        .from("deals")
        .select("*, stage:pipeline_stages(*)")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      deliveryEnabled
        ? supabase
            .from("delivery_orders")
            .select("*, items:delivery_order_items(*)")
            .eq("contact_id", contact.id)
            .order("created_at", { ascending: false })
            .limit(5)
        : Promise.resolve({ data: null }),
      supabase
        .from("contact_notes")
        .select("*")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_tags")
        .select("id, tag_id, tags(*)")
        .eq("contact_id", contact.id),
    ]);

    if (dealsRes.data) setDeals(dealsRes.data);
    setOrders((ordersRes.data as DeliveryOrder[] | null) ?? []);
    if (notesRes.data) setNotes(notesRes.data);
    if (tagsRes.data) {
      const mapped = tagsRes.data
        .filter((ct: Record<string, unknown>) => ct.tags)
        .map((ct: Record<string, unknown>) => ({
          ...(ct.tags as Tag),
          contact_tag_id: ct.id as string,
        }));
      setTags(mapped);
    }

    // Stage options for the inline changer — one lookup per distinct
    // pipeline among this contact's deals, not one per deal.
    const pipelineIds = Array.from(
      new Set((dealsRes.data ?? []).map((d) => d.pipeline_id).filter(Boolean)),
    );
    if (pipelineIds.length > 0) {
      const { data: stagesData } = await supabase
        .from("pipeline_stages")
        .select("*")
        .in("pipeline_id", pipelineIds)
        .order("position", { ascending: true });
      if (stagesData) {
        const grouped: Record<string, PipelineStage[]> = {};
        for (const stage of stagesData) {
          (grouped[stage.pipeline_id] ??= []).push(stage);
        }
        setStagesByPipeline(grouped);
      }
    } else {
      setStagesByPipeline({});
    }
  }, [contact, deliveryEnabled]);

  // Load on contact change. setContactData/setTags run inside async
  // Supabase callbacks, not synchronously in the effect body.
  useEffect(() => {
    fetchContactData();
  }, [fetchContactData]);

  // Every account tag, for the add-tag popover — loaded once (RLS
  // already scopes the `tags` table to the caller's account), not
  // refetched per contact.
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const supabase = createClient();
    supabase
      .from("tags")
      .select("*")
      .order("name")
      .then(({ data }) => {
        if (!cancelled && data) setAllTags(data);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  // Every pipeline + its stages, for the "add deal" popover — loaded
  // once per account, same reasoning as allTags above.
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const supabase = createClient();
    (async () => {
      const { data: pipelinesData } = await supabase
        .from("pipelines")
        .select("*")
        .order("created_at", { ascending: true });
      if (cancelled || !pipelinesData) return;
      setPipelines(pipelinesData);
      if (pipelinesData.length === 0) return;
      const { data: stagesData } = await supabase
        .from("pipeline_stages")
        .select("*")
        .in("pipeline_id", pipelinesData.map((p) => p.id))
        .order("position", { ascending: true });
      if (cancelled || !stagesData) return;
      const grouped: Record<string, PipelineStage[]> = {};
      for (const stage of stagesData) {
        (grouped[stage.pipeline_id] ??= []).push(stage);
      }
      setAllStagesByPipeline(grouped);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const toggleTag = useCallback(
    async (tag: Tag) => {
      if (!contact) return;
      setSavingTagId(tag.id);
      const existing = tags.find((t) => t.id === tag.id);
      try {
        if (existing) {
          await deleteContactTag(contact.id, tag.id);
          setTags((prev) => prev.filter((t) => t.id !== tag.id));
        } else {
          const result = await addContactTag(contact.id, tag.id);
          // Only append locally once the server confirms it wasn't a
          // duplicate — mirrors the idempotent-add semantics of
          // addContactTagIfAbsent so a double-click can't show two pills.
          if (result.added !== false) {
            setTags((prev) => [...prev, { ...tag, contact_tag_id: `${contact.id}:${tag.id}` }]);
          }
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : tSidebar("tagUpdateFailed"));
      } finally {
        setSavingTagId(null);
      }
    },
    [contact, tags, tSidebar],
  );

  const handleChangeDealStage = useCallback(
    async (deal: Deal, newStageId: string) => {
      if (newStageId === deal.stage_id) return;
      const pipelineStages = stagesByPipeline[deal.pipeline_id] ?? [];
      const newStage = pipelineStages.find((s) => s.id === newStageId);
      setChangingDealId(deal.id);
      // Optimistic — same pattern as the pipeline board's drag-and-drop
      // (pipelines/page.tsx's handleDealMoved).
      setDeals((prev) =>
        prev.map((d) =>
          d.id === deal.id ? { ...d, stage_id: newStageId, stage: newStage ?? d.stage } : d,
        ),
      );
      const supabase = createClient();
      const { error } = await supabase
        .from("deals")
        .update({ stage_id: newStageId })
        .eq("id", deal.id);
      if (error) {
        toast.error(tSidebar("dealStageUpdateFailed"));
        setDeals((prev) => prev.map((d) => (d.id === deal.id ? deal : d)));
      }
      setChangingDealId(null);
    },
    [stagesByPipeline, tSidebar],
  );

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // Dep is the whole `contact` object (not `contact?.phone`) so the
    // React Compiler's inference agrees with the manual dep list —
    // fixes the `preserve-manual-memoization` lint error.
  }, [contact]);

  const handleAddNote = useCallback(async () => {
    if (!contact || !newNote.trim()) return;
    if (!accountId) return;
    setAddingNote(true);

    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;

    const { data, error } = await supabase
      .from("contact_notes")
      .insert({
        contact_id: contact.id,
        account_id: accountId,
        user_id: user?.id,
        note_text: newNote.trim(),
      })
      .select()
      .single();

    if (!error && data) {
      setNotes((prev) => [data, ...prev]);
      setNewNote("");
    }
    setAddingNote(false);
  }, [contact, newNote, accountId]);

  const startEditContact = useCallback(() => {
    if (!contact) return;
    setEditName(contact.name ?? "");
    setEditEmail(contact.email ?? "");
    setEditCompany(contact.company ?? "");
    setEditingContact(true);
  }, [contact]);

  const handleSaveContact = useCallback(async () => {
    if (!contact) return;
    setSavingContact(true);
    const patch = {
      name: editName.trim() || null,
      email: editEmail.trim() || null,
      company: editCompany.trim() || null,
    };
    const supabase = createClient();
    const { error } = await supabase.from("contacts").update(patch).eq("id", contact.id);
    setSavingContact(false);
    if (error) {
      toast.error(tSidebar("contactUpdateFailed"));
      return;
    }
    // Contact's own fields are `string | undefined` (never null) — the
    // DB write above uses null to clear a column, but the in-memory
    // patch handed back to the parent needs to match that convention.
    onContactUpdated?.({
      name: patch.name ?? undefined,
      email: patch.email ?? undefined,
      company: patch.company ?? undefined,
    });
    setEditingContact(false);
    toast.success(tSidebar("contactUpdateSuccess"));
  }, [contact, editName, editEmail, editCompany, onContactUpdated, tSidebar]);

  const handleCreateDeal = useCallback(async () => {
    if (!contact || !accountId || !user) return;
    const title = dealTitle.trim();
    if (!title) {
      toast.error(tSidebar("dealTitleRequired"));
      return;
    }
    const pipelineId = dealPipelineId || pipelines[0]?.id;
    const stage = pipelineId ? allStagesByPipeline[pipelineId]?.[0] : undefined;
    if (!pipelineId || !stage) {
      toast.error(tSidebar("dealCreateFailed"));
      return;
    }
    setCreatingDeal(true);
    const supabase = createClient();
    const { data, error } = await supabase
      .from("deals")
      .insert({
        title,
        value: parseFloat(dealValue) || 0,
        currency: defaultCurrency,
        contact_id: contact.id,
        pipeline_id: pipelineId,
        stage_id: stage.id,
        user_id: user.id,
        account_id: accountId,
        status: "open",
      })
      .select("*, stage:pipeline_stages(*)")
      .single();
    setCreatingDeal(false);
    if (error || !data) {
      toast.error(tSidebar("dealCreateFailed"));
      return;
    }
    setDeals((prev) => [data, ...prev]);
    // The stage-changer dropdown reads from `stagesByPipeline` (contact-
    // scoped); merge this pipeline's stages in now so it renders
    // immediately instead of only after the next fetchContactData.
    setStagesByPipeline((prev) => ({
      ...prev,
      [pipelineId]: allStagesByPipeline[pipelineId] ?? prev[pipelineId] ?? [],
    }));
    setDealTitle("");
    setDealValue("");
    setAddDealOpen(false);
    toast.success(tSidebar("dealCreateSuccess"));
  }, [
    contact,
    accountId,
    user,
    dealTitle,
    dealValue,
    dealPipelineId,
    pipelines,
    allStagesByPipeline,
    defaultCurrency,
    tSidebar,
  ]);

  if (!contact) {
    return (
      <div className="flex h-full w-70 items-center justify-center border-l border-border bg-card">
        <p className="text-sm text-muted-foreground">{tThread("selectConversation")}</p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone;
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <div className="flex h-full w-70 flex-col border-l border-border bg-card">
      <ScrollArea className="flex-1">
        <div className="p-4">
          {/* Contact Info — editable inline so a typo or a missing
              email/company never requires a trip to /contacts. */}
          <div className="flex flex-col items-center text-center">
            <Avatar className="h-16 w-16 text-lg font-semibold text-foreground">
              <AvatarImage src={contact.avatar_url ?? undefined} alt={displayName} />
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
            {editingContact ? (
              <div className="mt-3 w-full space-y-2">
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder={tSidebar("namePlaceholder")}
                  className="w-full rounded-lg border border-border bg-muted px-3 py-1.5 text-center text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <input
                  value={editCompany}
                  onChange={(e) => setEditCompany(e.target.value)}
                  placeholder={tSidebar("companyPlaceholder")}
                  className="w-full rounded-lg border border-border bg-muted px-3 py-1.5 text-center text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <input
                  value={editEmail}
                  onChange={(e) => setEditEmail(e.target.value)}
                  placeholder={tSidebar("emailPlaceholder")}
                  type="email"
                  className="w-full rounded-lg border border-border bg-muted px-3 py-1.5 text-center text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <div className="flex justify-center gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEditingContact(false)}
                    disabled={savingContact}
                  >
                    {tCommon("cancel")}
                  </Button>
                  <Button size="sm" onClick={handleSaveContact} disabled={savingContact}>
                    {savingContact && <Loader2 className="h-3 w-3 animate-spin" />}
                    {tSidebar("save")}
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <div className="mt-3 flex items-center gap-1.5">
                  <h3 className="text-sm font-semibold text-foreground">{displayName}</h3>
                  <button
                    type="button"
                    onClick={startEditContact}
                    aria-label={tSidebar("editContact")}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                </div>
                {contact.company && (
                  <p className="text-xs text-muted-foreground">{contact.company}</p>
                )}
              </>
            )}
          </div>

          {/* Phone */}
          <div className="mt-4 space-y-2">
            <button
              onClick={handleCopyPhone}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
              <Phone className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 text-left">{contact.phone}</span>
              {copied ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <Copy className="h-3 w-3 text-muted-foreground" />
              )}
            </button>

            {contact.email && (
              <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span className="truncate">{contact.email}</span>
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Tags — inline add/remove picker (Popover of toggle-pills,
              same interaction as the Contacts page's Tags tab) so an
              agent never has to leave the inbox to tag a contact
              mid-attendance. */}
          <div>
            <div className="flex items-center justify-between gap-2 px-1">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <TagIcon className="h-3 w-3" />
                {tSidebar("tags")}
              </div>
              {allTags.length > 0 && (
                <Popover>
                  <PopoverTrigger
                    className="flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label={tSidebar("addTag")}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </PopoverTrigger>
                  <PopoverContent align="end" className="max-h-64 overflow-y-auto">
                    <div className="flex flex-wrap gap-1.5">
                      {allTags.map((tag) => {
                        const selected = tags.some((t) => t.id === tag.id);
                        return (
                          <button
                            key={tag.id}
                            type="button"
                            onClick={() => toggleTag(tag)}
                            disabled={savingTagId === tag.id}
                            className={cn(
                              "inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium transition-opacity disabled:opacity-50",
                              selected
                                ? "ring-2 ring-primary ring-offset-1 ring-offset-popover"
                                : "opacity-50 hover:opacity-80",
                            )}
                            style={{ backgroundColor: `${tag.color}20`, color: tag.color }}
                          >
                            {selected && <Check className="h-3 w-3" />}
                            {tag.name}
                          </button>
                        );
                      })}
                    </div>
                  </PopoverContent>
                </Popover>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {tags.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">{tSidebar("noTags")}</p>
              ) : (
                tags.map((tag) => (
                  <span
                    key={tag.contact_tag_id}
                    className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{
                      backgroundColor: `${tag.color}20`,
                      color: tag.color,
                    }}
                  >
                    {tag.name}
                  </span>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Active Deals */}
          <div>
            <div className="flex items-center justify-between gap-2 px-1">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <DollarSign className="h-3 w-3" />
                {tSidebar("deals")}
              </div>
              {pipelines.length > 0 && (
                <Popover open={addDealOpen} onOpenChange={setAddDealOpen}>
                  <PopoverTrigger
                    className="flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label={tSidebar("addDeal")}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-64 space-y-2">
                    <input
                      value={dealTitle}
                      onChange={(e) => setDealTitle(e.target.value)}
                      placeholder={tSidebar("dealTitlePlaceholder")}
                      className="w-full rounded-lg border border-border bg-muted px-3 py-1.5 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                    />
                    <input
                      value={dealValue}
                      onChange={(e) => setDealValue(e.target.value)}
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder={tSidebar("dealValuePlaceholder")}
                      className="w-full rounded-lg border border-border bg-muted px-3 py-1.5 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                    />
                    {pipelines.length > 1 && (
                      <Select
                        value={dealPipelineId || pipelines[0].id}
                        onValueChange={(v) => v && setDealPipelineId(v)}
                      >
                        <SelectTrigger size="sm" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {pipelines.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <Button
                      size="sm"
                      className="w-full"
                      onClick={handleCreateDeal}
                      disabled={creatingDeal || !dealTitle.trim()}
                    >
                      {creatingDeal && <Loader2 className="h-3 w-3 animate-spin" />}
                      {tSidebar("create")}
                    </Button>
                  </PopoverContent>
                </Popover>
              )}
            </div>
            <div className="mt-2 space-y-2">
              {deals.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">{tSidebar("noDeals")}</p>
              ) : (
                deals.map((deal) => {
                  const pipelineStages = stagesByPipeline[deal.pipeline_id] ?? [];
                  return (
                    <div
                      key={deal.id}
                      className="rounded-lg bg-muted px-3 py-2"
                    >
                      <p className="text-sm font-medium text-foreground">
                        {deal.title}
                      </p>
                      <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span>
                          {formatCurrency(deal.value, deal.currency || defaultCurrency)}
                        </span>
                        {/* Inline stage changer — same write path as the
                            Kanban board's drag-and-drop
                            (pipelines/page.tsx's handleDealMoved), just
                            triggered from a dropdown instead of a drag
                            so an agent can move a deal without leaving
                            the inbox. Falls back to the plain read-only
                            badge if the pipeline's stages haven't
                            loaded (or there's only one deal card and no
                            stage — e.g. mid-fetch). */}
                        {pipelineStages.length > 0 ? (
                          <Select
                            value={deal.stage_id}
                            onValueChange={(v) => v && handleChangeDealStage(deal, v)}
                            disabled={changingDealId === deal.id}
                          >
                            <SelectTrigger
                              size="sm"
                              className="border-none bg-transparent px-1.5 py-0.5 text-[10px] font-medium"
                              style={deal.stage ? { color: deal.stage.color } : undefined}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent align="end">
                              {pipelineStages.map((stage) => (
                                <SelectItem key={stage.id} value={stage.id}>
                                  <span
                                    className="h-2 w-2 shrink-0 rounded-full"
                                    style={{ backgroundColor: stage.color }}
                                  />
                                  {stage.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          deal.stage && (
                            <span
                              className="rounded-full px-1.5 py-0.5 text-[10px]"
                              style={{
                                backgroundColor: `${deal.stage.color}20`,
                                color: deal.stage.color,
                              }}
                            >
                              {deal.stage.name}
                            </span>
                          )
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Delivery Orders — only when the account has the module on */}
          {deliveryEnabled && (
            <>
              <div>
                <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  <UtensilsCrossed className="h-3 w-3" />
                  {tSidebar("orders")}
                </div>
                <div className="mt-2 space-y-2">
                  {orders.length === 0 ? (
                    <p className="px-1 text-xs text-muted-foreground">{tSidebar("noOrders")}</p>
                  ) : (
                    orders.map((order) => (
                      <DeliveryOrderMiniCard
                        key={order.id}
                        order={order}
                        onClick={() => router.push(`/delivery/pedidos?order=${order.id}`)}
                      />
                    ))
                  )}
                </div>
              </div>
              <div className="my-4 border-t border-border" />
            </>
          )}

          {/* Notes */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <StickyNote className="h-3 w-3" />
              {tSidebar("notes")}
            </div>
            <div className="mt-2">
              <div className="flex gap-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder={tSidebar("addNotePlaceholder")}
                  rows={2}
                  className="flex-1 resize-none rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <Button
                  size="sm"
                  className="h-auto bg-primary px-2 hover:bg-primary/90"
                  onClick={handleAddNote}
                  disabled={!newNote.trim() || addingNote}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>

              <div className="mt-2 space-y-2">
                {notes.map((note) => (
                  <div
                    key={note.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                      {note.note_text}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {format(new Date(note.created_at), "MMM d, yyyy HH:mm")}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
