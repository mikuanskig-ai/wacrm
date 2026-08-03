import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import * as wuzapiApi from '@/lib/whatsapp/wuzapi-api'
import { decrypt } from '@/lib/whatsapp/encryption'

/**
 * Resolve the caller's account_id from their profile.
 */
async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

/**
 * DELETE /api/whatsapp/config
 *
 * Fully disconnects the account's WhatsApp channel: logs the WuzAPI
 * session out (best-effort — a wuzapi-side failure must never block
 * local cleanup, since the operator can always kill the session
 * manually), deletes every deal tied to a contact of this account
 * (deals are never orphaned as leftover "US$ 0" cards on the Kanban
 * board — `deals.contact_id` is `ON DELETE SET NULL`, see
 * 004_contact_delete_set_null.sql, so it survives a contact delete by
 * design elsewhere; here the whole channel is gone, so there's nothing
 * left to keep it for), then every contact (existing FK CASCADE on
 * `conversations.contact_id` — see 001_initial_schema.sql — fans out
 * to messages/message_actions/contact_tags/contact_notes/
 * contact_custom_values automatically), then deletes the config row
 * itself. All destructive — the UI gates this behind an explicit
 * confirmation dialog, not the old bare `confirm()`.
 */
export async function DELETE() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const { data: existingConfig } = await supabase
      .from('whatsapp_config')
      .select('wuzapi_base_url, wuzapi_token')
      .eq('account_id', accountId)
      .maybeSingle()

    if (existingConfig?.wuzapi_base_url && existingConfig.wuzapi_token) {
      try {
        await wuzapiApi.logoutSession({
          baseUrl: existingConfig.wuzapi_base_url,
          token: decrypt(existingConfig.wuzapi_token),
        })
      } catch (err) {
        console.error(
          '[whatsapp/config] wuzapi logout failed (continuing with local cleanup):',
          err instanceof Error ? err.message : err,
        )
      }
    }

    const { error: dealsDeleteError } = await supabase
      .from('deals')
      .delete()
      .eq('account_id', accountId)
      .not('contact_id', 'is', null)

    if (dealsDeleteError) {
      console.error('Error deleting deals:', dealsDeleteError)
      return NextResponse.json(
        { error: 'Failed to delete deals for this channel' },
        { status: 500 }
      )
    }

    const { error: contactsDeleteError } = await supabase
      .from('contacts')
      .delete()
      .eq('account_id', accountId)

    if (contactsDeleteError) {
      console.error('Error deleting contacts:', contactsDeleteError)
      return NextResponse.json(
        { error: 'Failed to delete contacts for this channel' },
        { status: 500 }
      )
    }

    const { error: deleteError } = await supabase
      .from('whatsapp_config')
      .delete()
      .eq('account_id', accountId)

    if (deleteError) {
      console.error('Error deleting whatsapp_config:', deleteError)
      return NextResponse.json(
        { error: 'Failed to delete configuration' },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in WhatsApp config DELETE:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
