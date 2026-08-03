// ============================================================
// Campaign core — WuzAPI "broadcast" with scheduling, per-recipient
// delay pacing, up to 3 randomly-picked message variants, and
// {{field}} variable substitution from the contact's custom fields.
// Modeled after Whazing's own campaign dispatcher (the user's other
// product): scheduled start + delay between sends is the main lever
// against a personal WhatsApp number getting banned for bulk sending
// — there is no Meta-template approval step protecting against that
// here, so pacing is not optional polish.
//
// Two phases, mirroring the flows/automations cron pattern already in
// this codebase:
//
//   createCampaign()     — validate, resolve recipients (either an
//                          explicit list from the public API, or a
//                          tag/all segment from the dashboard),
//                          persist `broadcasts` + `broadcast_recipients`
//                          (status 'pending'). Nothing is sent here.
//   dispatchDueCampaigns() — cron worker. Repeatedly finds ONE campaign
//                          that's due (scheduled_at reached AND its
//                          own delay_seconds has elapsed since
//                          last_sent_at) and sends its next pending
//                          recipient, until the time budget runs out
//                          or there's no due work. Round-robins across
//                          concurrently-running campaigns.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import * as wuzapiApi from '@/lib/whatsapp/wuzapi-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';
import { findOrCreateContact } from '@/lib/api/v1/contacts';
import { getSuspendedAccountIds } from '@/lib/accounts/suspension';
import type { CampaignSegment } from '@/types';

export class BroadcastError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'BroadcastError';
    this.code = code;
    this.status = status;
  }
}

export interface BroadcastRecipientInput {
  to: string;
  name?: string;
}

export interface CreateCampaignParams {
  name?: string | null;
  /** 1-3 message variants; one is picked at random per recipient. */
  messageVariants: string[];
  mediaUrl?: string | null;
  /** Seconds between each recipient send. 0 = as fast as the cron ticks. */
  delaySeconds: number;
  /** null/undefined = send now. In the future = 'scheduled' until reached. */
  scheduledAt?: string | null;
  /** Dashboard path: resolve recipients from a tag/all segment. */
  segment?: CampaignSegment;
  /** Public-API path: explicit recipient list. */
  recipients?: BroadcastRecipientInput[];
}

export interface CreateCampaignResult {
  broadcastId: string;
  totalRecipients: number;
  rejected: number;
}

const MAX_RECIPIENTS = 2000;
const MAX_VARIANTS = 3;

async function resolveRecipientsFromSegment(
  db: SupabaseClient,
  accountId: string,
  segment: CampaignSegment
): Promise<{ contactId: string; phone: string; name: string }[]> {
  let query = db
    .from('contacts')
    .select('id, phone, name')
    .eq('account_id', accountId)
    .not('phone', 'is', null);

  if (segment.type === 'tags') {
    if (!Array.isArray(segment.tag_ids) || segment.tag_ids.length === 0) {
      throw new BroadcastError('bad_request', 'segment.tag_ids must be a non-empty array', 400);
    }
    const { data: taggedRows, error: tagErr } = await db
      .from('contact_tags')
      .select('contact_id')
      .in('tag_id', segment.tag_ids);
    if (tagErr) {
      throw new BroadcastError('internal', 'Failed to resolve tag segment', 500);
    }
    const contactIds = Array.from(new Set((taggedRows ?? []).map((r) => r.contact_id as string)));
    if (contactIds.length === 0) return [];
    query = query.in('id', contactIds);
  }

  const { data, error } = await query;
  if (error) {
    throw new BroadcastError('internal', 'Failed to resolve audience', 500);
  }
  return (data ?? []).map((c) => ({
    contactId: c.id as string,
    phone: (c.phone as string) ?? '',
    name: (c.name as string) ?? '',
  }));
}

export async function createCampaign(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  params: CreateCampaignParams
): Promise<CreateCampaignResult> {
  const { name, mediaUrl, delaySeconds, scheduledAt, segment, recipients } = params;

  const variants = (params.messageVariants ?? [])
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter(Boolean)
    .slice(0, MAX_VARIANTS);
  if (variants.length === 0) {
    throw new BroadcastError('bad_request', 'At least one message variant is required', 400);
  }

  // Shape-only checks up front, before any DB round trip, so a bad
  // request 400s without touching Supabase at all.
  if (!segment) {
    if (!Array.isArray(recipients) || recipients.length === 0) {
      throw new BroadcastError('bad_request', 'Provide either `segment` or `recipients`', 400);
    }
    if (recipients.length > MAX_RECIPIENTS) {
      throw new BroadcastError(
        'bad_request',
        `A campaign is capped at ${MAX_RECIPIENTS} recipients per request`,
        400
      );
    }
  }

  const { data: config } = await db
    .from('whatsapp_config')
    .select('id')
    .eq('account_id', accountId)
    .maybeSingle();
  if (!config) {
    throw new BroadcastError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }

  // Resolve the audience: either an explicit list (public API) or a
  // tag/all segment (dashboard) — exactly one path is used.
  let resolved: { contactId: string; phone: string; name: string }[];
  if (segment) {
    resolved = await resolveRecipientsFromSegment(db, accountId, segment);
  } else {
    resolved = [];
    for (const r of recipients!) {
      const sanitized = sanitizePhoneForMeta(typeof r.to === 'string' ? r.to : '');
      if (!isValidE164(sanitized)) continue;
      const { id } = await findOrCreateContact(db, accountId, auditUserId, { phone: sanitized });
      resolved.push({ contactId: id, phone: sanitized, name: r.name ?? '' });
    }
  }

  const seenContact = new Set<string>();
  const deduped = resolved.filter((r) => {
    const sanitized = sanitizePhoneForMeta(r.phone);
    if (!isValidE164(sanitized) || seenContact.has(r.contactId)) return false;
    seenContact.add(r.contactId);
    return true;
  });
  const rejected = resolved.length - deduped.length;

  if (deduped.length === 0) {
    throw new BroadcastError('bad_request', 'No recipients resolved for this campaign', 400);
  }
  if (deduped.length > MAX_RECIPIENTS) {
    throw new BroadcastError(
      'bad_request',
      `A campaign is capped at ${MAX_RECIPIENTS} recipients; narrow the segment`,
      400
    );
  }

  const scheduled = scheduledAt ? new Date(scheduledAt) : null;
  const status = scheduled && scheduled.getTime() > Date.now() ? 'scheduled' : 'sending';

  const { data: broadcast, error: bErr } = await db
    .from('broadcasts')
    .insert({
      account_id: accountId,
      user_id: auditUserId,
      name: name || 'Campaign',
      message_variants: variants,
      media_url: mediaUrl || null,
      delay_seconds: Math.max(0, Math.floor(delaySeconds || 0)),
      whatsapp_config_id: config.id,
      scheduled_at: scheduled ? scheduled.toISOString() : null,
      audience_filter: segment ?? null,
      status,
      total_recipients: deduped.length,
    })
    .select('id')
    .single();
  if (bErr || !broadcast) {
    console.error('[broadcast-core] create campaign error:', bErr);
    throw new BroadcastError('internal', 'Failed to create campaign', 500);
  }

  const { error: rErr } = await db.from('broadcast_recipients').insert(
    deduped.map((r) => ({
      broadcast_id: broadcast.id,
      contact_id: r.contactId,
      status: 'pending' as const,
    }))
  );
  if (rErr) {
    console.error('[broadcast-core] create recipients error:', rErr);
    throw new BroadcastError('internal', 'Failed to create campaign', 500);
  }

  return { broadcastId: broadcast.id, totalRecipients: deduped.length, rejected };
}

/** Pure — one variant at random, deterministic-free so tests can just
 *  check membership rather than mock Math.random. */
export function pickVariant(variants: string[]): string {
  if (variants.length === 0) return '';
  return variants[Math.floor(Math.random() * variants.length)];
}

/** Resolve `{{field}}` tokens against the contact's custom fields,
 *  falling back to the built-in `nome`/`telefone`. Unknown tokens
 *  resolve to '' rather than being left literally in the text. */
export function resolveCampaignVariables(
  template: string,
  contact: { name: string; phone: string },
  customFields: Record<string, string>
): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    if (key in customFields) return customFields[key];
    if (key === 'nome') return contact.name || '';
    if (key === 'telefone') return contact.phone || '';
    return '';
  });
}

async function loadCustomFieldValues(
  db: SupabaseClient,
  contactId: string
): Promise<Record<string, string>> {
  const { data, error } = await db
    .from('contact_custom_values')
    .select('value, custom_fields(field_name)')
    .eq('contact_id', contactId);
  if (error || !data) return {};
  const out: Record<string, string> = {};
  for (const row of data as unknown as { value: string | null; custom_fields: { field_name: string } | null }[]) {
    const fieldName = row.custom_fields?.field_name;
    if (fieldName) out[fieldName] = row.value ?? '';
  }
  return out;
}

interface DueCampaign {
  id: string;
  message_variants: string[];
  media_url: string | null;
  delay_seconds: number;
  last_sent_at: string | null;
  wuzapi_base_url: string;
  wuzapi_token: string;
}

/** One campaign + its whatsapp_config, joined, for the dispatcher.
 *  `suspended` — migration 062: skip campaigns whose account was
 *  suspended after being scheduled, same as a disconnected channel. */
async function nextDueCampaign(
  db: SupabaseClient,
  suspended: Set<string>,
): Promise<DueCampaign | null> {
  const nowIso = new Date().toISOString();
  const { data, error } = await db
    .from('broadcasts')
    .select('id, account_id, message_variants, media_url, delay_seconds, last_sent_at, whatsapp_config_id, whatsapp_config:whatsapp_config_id(wuzapi_base_url, wuzapi_token)')
    .in('status', ['scheduled', 'sending'])
    .or(`scheduled_at.is.null,scheduled_at.lte.${nowIso}`)
    .limit(25);
  if (error || !data) return null;

  for (const row of data as unknown as {
    id: string;
    account_id: string;
    message_variants: string[];
    media_url: string | null;
    delay_seconds: number;
    last_sent_at: string | null;
    whatsapp_config: { wuzapi_base_url: string | null; wuzapi_token: string | null } | null;
  }[]) {
    if (suspended.has(row.account_id)) continue; // account suspended after scheduling
    const cfg = row.whatsapp_config;
    if (!cfg?.wuzapi_base_url || !cfg?.wuzapi_token) continue; // channel disconnected mid-campaign
    if (row.last_sent_at) {
      const elapsedMs = Date.now() - new Date(row.last_sent_at).getTime();
      if (elapsedMs < row.delay_seconds * 1000) continue; // not due yet
    }
    return {
      id: row.id,
      message_variants: row.message_variants,
      media_url: row.media_url,
      delay_seconds: row.delay_seconds,
      last_sent_at: row.last_sent_at,
      wuzapi_base_url: cfg.wuzapi_base_url,
      wuzapi_token: cfg.wuzapi_token,
    };
  }
  return null;
}

/** Cheap existence check — is there ANY campaign in a dispatchable
 *  status at all? Lets the loop below return immediately when the
 *  account has no campaigns running, instead of burning the whole
 *  budget sleeping on a table that's simply empty. */
async function anyDispatchableCampaignExists(db: SupabaseClient): Promise<boolean> {
  const { count } = await db
    .from('broadcasts')
    .select('id', { count: 'exact', head: true })
    .in('status', ['scheduled', 'sending']);
  return (count ?? 0) > 0;
}

/**
 * Drain due campaigns for up to `budgetMs`. Sends at most one
 * recipient per campaign per loop iteration so several campaigns
 * running concurrently interleave fairly rather than one starving the
 * rest. Returns how many messages were actually sent, for the cron
 * route's log line.
 */
export async function dispatchDueCampaigns(
  db: SupabaseClient,
  budgetMs: number
): Promise<{ sent: number }> {
  const deadline = Date.now() + budgetMs;
  let sent = 0;
  const suspended = await getSuspendedAccountIds(db);

  while (Date.now() < deadline) {
    const campaign = await nextDueCampaign(db, suspended);
    if (!campaign) {
      // Nothing due right now. If nothing is even in flight, there's
      // no point waiting out the rest of the budget — return early so
      // an idle account's cron tick is cheap instead of a guaranteed
      // full-budget hold.
      if (!(await anyDispatchableCampaignExists(db))) break;
      // Something exists but isn't due yet (still inside its own
      // delay_seconds window) — a short pause avoids hammering the DB
      // in a tight loop while waiting it out.
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }

    const { data: recipient } = await db
      .from('broadcast_recipients')
      .select('id, contact_id')
      .eq('broadcast_id', campaign.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!recipient) {
      // No pending recipients left — finalize.
      await db
        .from('broadcasts')
        .update({ status: 'sent', updated_at: new Date().toISOString() })
        .eq('id', campaign.id);
      continue;
    }

    const { data: contact } = await db
      .from('contacts')
      .select('id, name, phone')
      .eq('id', recipient.contact_id)
      .maybeSingle();

    if (!contact?.phone) {
      await db
        .from('broadcast_recipients')
        .update({ status: 'failed', error_message: 'Contact has no phone' })
        .eq('id', recipient.id);
      continue;
    }

    const customFields = await loadCustomFieldValues(db, contact.id);
    const text = resolveCampaignVariables(
      pickVariant(campaign.message_variants),
      { name: contact.name ?? '', phone: contact.phone },
      customFields
    );

    try {
      const result = campaign.media_url
        ? await wuzapiApi.sendMediaMessage({
            baseUrl: campaign.wuzapi_base_url,
            token: decrypt(campaign.wuzapi_token),
            to: contact.phone,
            kind: 'image',
            dataUri: campaign.media_url,
            caption: text,
          })
        : await wuzapiApi.sendTextMessage({
            baseUrl: campaign.wuzapi_base_url,
            token: decrypt(campaign.wuzapi_token),
            to: contact.phone,
            text,
          });
      await db
        .from('broadcast_recipients')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          whatsapp_message_id: result.messageId,
          error_message: null,
        })
        .eq('id', recipient.id);
      sent++;
    } catch (error) {
      await db
        .from('broadcast_recipients')
        .update({
          status: 'failed',
          error_message: error instanceof Error ? error.message : 'Unknown error',
        })
        .eq('id', recipient.id);
    }

    await db
      .from('broadcasts')
      .update({
        status: 'sending',
        last_sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', campaign.id);
  }

  return { sent };
}
