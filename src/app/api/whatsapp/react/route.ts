import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import * as wuzapiApi from '@/lib/whatsapp/wuzapi-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';

/**
 * POST /api/whatsapp/react
 *
 * Body: { message_id: <internal UUID>, emoji: <single emoji or "" to remove> }
 *
 * Relays the reaction to WhatsApp via WuzAPI's /chat/react first
 * (fail-fast, same order as sendMessageToConversation — never persist
 * a reaction locally that didn't actually reach WhatsApp), then
 * mirrors it into `message_reactions` (delete on empty emoji) so it
 * shows in the inbox. Customer-side reactions are handled by the
 * webhook — this route only writes `actor_type = 'agent'` rows.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const limit = checkRateLimit(`react:${user.id}`, RATE_LIMITS.react);
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle();
    const accountId = profile?.account_id as string | undefined;
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      );
    }

    const body = await request.json();
    const { message_id, emoji } = body as {
      message_id?: string;
      emoji?: string;
    };

    if (!message_id || typeof emoji !== 'string') {
      return NextResponse.json(
        { error: 'message_id and emoji are required' },
        { status: 400 },
      );
    }

    const { data: targetMessage, error: msgError } = await supabase
      .from('messages')
      .select('id, conversation_id, message_id, sender_type')
      .eq('id', message_id)
      .maybeSingle();

    if (msgError || !targetMessage) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('id, contact:contacts(phone)')
      .eq('id', targetMessage.conversation_id)
      .eq('account_id', accountId)
      .maybeSingle();

    if (convError || !conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 },
      );
    }

    if (!targetMessage.message_id) {
      return NextResponse.json(
        { error: 'This message has no WhatsApp id yet and cannot be reacted to' },
        { status: 400 },
      );
    }

    // Supabase's generated types say this join is an array, but with a
    // real FK (conversations.contact_id -> contacts.id) it comes back
    // as a single object at runtime — same mismatch handled the same
    // way in lib/dashboard/queries.ts. Trusting the TS-inferred array
    // shape here (`.contact?.[0]`) silently broke every reaction with
    // "Contact phone number not found", since the real payload has no
    // `[0]`.
    const rawContact = conversation.contact as
      | { phone: string | null }
      | { phone: string | null }[]
      | null;
    const contactPhone = (
      Array.isArray(rawContact) ? rawContact[0] : rawContact
    )?.phone as string | undefined;
    if (!contactPhone) {
      return NextResponse.json(
        { error: 'Contact phone number not found' },
        { status: 400 },
      );
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('wuzapi_base_url, wuzapi_token')
      .eq('account_id', accountId)
      .maybeSingle();

    if (configError || !config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured' },
        { status: 400 },
      );
    }

    const isOwnMessage = targetMessage.sender_type !== 'customer';
    try {
      await wuzapiApi.sendReaction({
        baseUrl: config.wuzapi_base_url,
        token: decrypt(config.wuzapi_token),
        to: sanitizePhoneForMeta(contactPhone),
        messageId: isOwnMessage
          ? `me:${targetMessage.message_id}`
          : targetMessage.message_id,
        emoji,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown WhatsApp API error';
      console.error('[whatsapp/react] WuzAPI relay failed:', message);
      return NextResponse.json(
        { error: `WuzAPI error: ${message}` },
        { status: 502 },
      );
    }

    if (emoji === '') {
      const { error: delError } = await supabase
        .from('message_reactions')
        .delete()
        .eq('message_id', targetMessage.id)
        .eq('actor_type', 'agent')
        .eq('actor_id', user.id);

      if (delError) {
        console.error('[whatsapp/react] DB delete failed:', delError.message);
        return NextResponse.json(
          { error: 'Failed to remove reaction' },
          { status: 500 },
        );
      }
    } else {
      const { error: upsertError } = await supabase.from('message_reactions').upsert(
        {
          message_id: targetMessage.id,
          conversation_id: targetMessage.conversation_id,
          actor_type: 'agent',
          actor_id: user.id,
          emoji,
        },
        { onConflict: 'message_id,actor_type,actor_id' },
      );

      if (upsertError) {
        console.error('[whatsapp/react] DB upsert failed:', upsertError.message);
        return NextResponse.json(
          { error: 'Failed to save reaction' },
          { status: 500 },
        );
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error in WhatsApp react POST:', error);
    return NextResponse.json(
      { error: 'Failed to react to message' },
      { status: 500 },
    );
  }
}
