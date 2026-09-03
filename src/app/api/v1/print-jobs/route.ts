// ============================================================
// GET /api/v1/print-jobs — list pending Delivery print jobs
// (scope: print:read)
//
// Consumed by a local print agent (polling — see print-agent/)
// rather than a human. Not cursor-paginated like the other v1 list
// endpoints: this is a small live operational queue, not a browsable
// history. Returns up to PRINT_JOB_LIMIT oldest-first pending jobs
// plus `pending_count` (the true total, so a backlog beyond the page
// is distinguishable from "caught up").
//
// Jobs are ATOMICALLY CLAIMED (claim_print_jobs RPC, migration 060),
// not just selected — a plain SELECT here let two concurrent pollers
// (e.g. the agent accidentally left running twice on the shop's PC)
// each print the same job before either got to ack it, a real
// double-print bug observed live. The RPC uses FOR UPDATE SKIP LOCKED
// so no two concurrent calls can ever be handed the same row.
//
// Each job embeds its full receipt (order + items + customer name)
// so the agent never needs a second round trip per job before it can
// print. Two flat queries + an in-memory join (not a 3-level nested
// PostgREST embed) — mirrors the pattern already used by
// loadPublicMenu (src/lib/delivery/public-menu.ts) rather than
// gambling on deep embed syntax.
// ============================================================

import { NextResponse } from 'next/server';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import { touchPrintAgentPoll } from '@/lib/delivery/print-queue';

const PRINT_JOB_LIMIT = 20;

interface OrderRow {
  id: string;
  status: string;
  status_changed_at: string | null;
  source: string;
  customer_name: string | null;
  delivery_address: string | null;
  notes: string | null;
  payment_method: string | null;
  payment_notes: string | null;
  subtotal: number;
  delivery_fee: number | null;
  total: number;
  currency: string;
  created_at: string;
  contact: { name: string | null; phone: string | null } | null;
}

interface ItemRow {
  order_id: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  addons_snapshot: unknown;
  line_total: number;
  notes: string | null;
}

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'print:read');
    touchPrintAgentPoll(ctx.accountId);

    const nowIso = new Date().toISOString();
    const dueFilter = `next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`;

    const { data: account } = await ctx.supabase
      .from('accounts')
      .select('name')
      .eq('id', ctx.accountId)
      .maybeSingle();

    // Atomic claim (see header comment) — never a plain SELECT of
    // 'pending' jobs, which a concurrent second poller could also see
    // and print before either got to ack.
    const { data: jobRows, error: jobsErr } = await ctx.supabase.rpc('claim_print_jobs', {
      p_account_id: ctx.accountId,
      p_limit: PRINT_JOB_LIMIT,
    });

    if (jobsErr) {
      console.error('[api/v1/print-jobs] claim error:', jobsErr);
      return NextResponse.json(
        { error: { code: 'internal', message: 'Failed to list print jobs' } },
        { status: 500 },
      );
    }

    // RETURNING from the claim UPDATE has no guaranteed order — resort
    // oldest-first (the RPC's own ORDER BY only controls which rows
    // get claimed, not the order they come back in).
    const jobs = ((jobRows ?? []) as { id: string; order_id: string; created_at: string; attempts: number }[]).sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    const orderIds = jobs.map((j) => j.order_id);

    let orders: OrderRow[] = [];
    let items: ItemRow[] = [];
    if (orderIds.length > 0) {
      const [ordersRes, itemsRes] = await Promise.all([
        ctx.supabase
          .from('delivery_orders')
          .select(
            'id, status, status_changed_at, source, customer_name, delivery_address, notes, payment_method, payment_notes, subtotal, delivery_fee, total, currency, created_at, contact:contacts(name, phone)',
          )
          .in('id', orderIds),
        ctx.supabase
          .from('delivery_order_items')
          .select('order_id, product_name, quantity, unit_price, addons_snapshot, line_total, notes')
          .in('order_id', orderIds),
      ]);
      orders = (ordersRes.data ?? []) as unknown as OrderRow[];
      items = (itemsRes.data ?? []) as ItemRow[];
    }
    const orderById = new Map(orders.map((o) => [o.id, o]));

    // A job whose order was cancelled after enqueue is skipped rather
    // than served — self-healing, no need to touch the order-cancel
    // route. BUT only when the job predates the cancellation (an order
    // voided before its original ticket ever printed) — a job created
    // AT OR AFTER the cancellation is a deliberate corrective re-print
    // (notifyOrderCancellation, print-queue.ts, fires when the kitchen
    // already had a printed ticket for the order) and must always be
    // served, never skipped, or the kitchen never gets the corrected
    // "CANCELADO" ticket at all. Confirmed live (2026-09-03,
    // Concórdia): this exact blanket rule swallowed that corrective job
    // itself before the agent ever saw it — two orders stayed
    // uncorrected in the kitchen's hands despite the fix from two days
    // earlier. Unknown timing (no status_changed_at) falls back to
    // serving the job rather than skipping it — worst case that prints
    // one harmless already-marked-CANCELADO ticket for an order that
    // never had a real one; the alternative (skip) risks silently
    // dropping a real corrective notice again.
    const cancelledJobIds = jobs
      .filter((j) => {
        const order = orderById.get(j.order_id);
        if (order?.status !== 'cancelled') return false;
        if (!order.status_changed_at) return false;
        return new Date(j.created_at).getTime() < new Date(order.status_changed_at).getTime();
      })
      .map((j) => j.id);
    if (cancelledJobIds.length > 0) {
      await ctx.supabase.from('print_jobs').update({ status: 'skipped' }).in('id', cancelledJobIds);
    }

    const { count: pendingCount } = await ctx.supabase
      .from('print_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', ctx.accountId)
      .eq('status', 'pending')
      .or(dueFilter);

    const servedJobs = jobs
      .filter((j) => !cancelledJobIds.includes(j.id))
      .map((j) => {
        const order = orderById.get(j.order_id);
        return {
          id: j.id,
          order_id: j.order_id,
          created_at: j.created_at,
          attempts: j.attempts,
          receipt: order
            ? {
                status: order.status,
                source: order.source,
                customer_name: order.contact?.name || order.customer_name || null,
                customer_phone: order.contact?.phone ?? null,
                delivery_address: order.delivery_address,
                notes: order.notes,
                payment_method: order.payment_method,
                payment_notes: order.payment_notes,
                subtotal: order.subtotal,
                delivery_fee: order.delivery_fee,
                total: order.total,
                currency: order.currency,
                created_at: order.created_at,
                items: items
                  .filter((i) => i.order_id === j.order_id)
                  .map((i) => ({
                    product_name: i.product_name,
                    quantity: i.quantity,
                    unit_price: i.unit_price,
                    addons_snapshot: i.addons_snapshot,
                    line_total: i.line_total,
                    notes: i.notes,
                  })),
              }
            : null,
        };
      });

    return ok({
      account_name: account?.name ?? null,
      pending_count: pendingCount ?? 0,
      jobs: servedJobs,
    });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
