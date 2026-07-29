// ============================================================
// Auto-add contacts into pipelines — shared by every contact-
// creation path (inbound webhook, public API, manual "Add contact",
// CSV import) and by the one-off "add existing contacts now" backfill
// action in Pipeline Settings.
//
// `db` is typed loosely as a Supabase client so the same functions
// work with the browser (RLS-scoped) client used by the client-side
// creation paths and the service-role client used by the webhook.
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabaseClient = any;

export interface AutoAddContact {
  id: string;
  name: string | null;
  phone: string;
}

/**
 * Insert a deal in `pipelineId`/`stageId` for every contact in
 * `contacts` that doesn't already have one there — the `deals` table
 * has no uniqueness constraint, so this in-memory `Set` diff is the
 * only guard against duplicates. Best-effort: a failure is logged and
 * treated as "0 added" rather than thrown, so a misconfigured
 * pipeline can never break contact creation.
 */
async function addContactsToStage(
  db: AnySupabaseClient,
  accountId: string,
  userId: string,
  pipelineId: string,
  stageId: string,
  contacts: AutoAddContact[],
): Promise<number> {
  if (contacts.length === 0) return 0;

  const contactIds = contacts.map((c) => c.id);
  const { data: existingDeals, error: existErr } = await db
    .from("deals")
    .select("contact_id")
    .eq("pipeline_id", pipelineId)
    .in("contact_id", contactIds);

  if (existErr) {
    console.error("[auto-add-pipeline] failed to check existing deals:", existErr.message);
    return 0;
  }

  const already = new Set(
    (existingDeals ?? []).map((d: { contact_id: string }) => d.contact_id),
  );
  const rows = contacts
    .filter((c) => !already.has(c.id))
    .map((c) => ({
      account_id: accountId,
      user_id: userId,
      pipeline_id: pipelineId,
      stage_id: stageId,
      contact_id: c.id,
      title: c.name || c.phone,
      status: "open",
    }));

  if (rows.length === 0) return 0;

  const { error: insErr } = await db.from("deals").insert(rows);
  if (insErr) {
    console.error("[auto-add-pipeline] failed to insert deals:", insErr.message);
    return 0;
  }
  return rows.length;
}

/**
 * Called right after one or more contacts are created (any path).
 * Drops each of `contacts` into every pipeline in `accountId` that
 * has auto-add turned on (Pipeline Settings → "Adicionar novos
 * contatos automaticamente"). No-op if no pipeline has it on, or the
 * lookup itself fails — never blocks contact creation.
 */
export async function autoAddContactsToPipelines(
  db: AnySupabaseClient,
  accountId: string,
  userId: string,
  contacts: AutoAddContact[],
): Promise<void> {
  if (contacts.length === 0) return;
  try {
    const { data: pipelines, error } = await db
      .from("pipelines")
      .select("id, auto_add_stage_id")
      .eq("account_id", accountId)
      .eq("auto_add_contacts", true)
      .not("auto_add_stage_id", "is", null);

    if (error || !pipelines || pipelines.length === 0) return;

    for (const pipeline of pipelines as { id: string; auto_add_stage_id: string }[]) {
      await addContactsToStage(
        db,
        accountId,
        userId,
        pipeline.id,
        pipeline.auto_add_stage_id,
        contacts,
      );
    }
  } catch (err) {
    console.error("[auto-add-pipeline] unexpected failure:", err);
  }
}

/**
 * One-off "add existing contacts now" backfill for a single
 * pipeline/stage — used by the Pipeline Settings dialog, independent
 * of whether auto-add is currently toggled on. Returns how many deals
 * were actually created (contacts that already had a deal there are
 * skipped, not counted).
 */
export async function backfillContactsToStage(
  db: AnySupabaseClient,
  accountId: string,
  userId: string,
  pipelineId: string,
  stageId: string,
  contacts: AutoAddContact[],
): Promise<number> {
  return addContactsToStage(db, accountId, userId, pipelineId, stageId, contacts);
}
