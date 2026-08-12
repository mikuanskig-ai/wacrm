import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { validateAiCredentials } from '@/lib/ai/validate'
import { embedTexts } from '@/lib/ai/embeddings'
import { AiError, AI_PROVIDERS, type AiProvider } from '@/lib/ai/types'
import { MAX_TOOL_ITERATIONS_DEFAULT, MAX_TOOL_ITERATIONS_CEILING } from '@/lib/ai/defaults'
import { parseBusinessHoursWeek } from '@/lib/delivery/business-hours'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * GET /api/ai/config
 *
 * Any member may read the config so the inbox/settings can reflect
 * whether AI is set up. The encrypted key is NEVER returned — only a
 * `has_key` flag; the settings form shows a masked placeholder.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data, error } = await supabase
      .from('ai_configs')
      // `api_key` is selected only to derive `has_key` — it is stripped
      // out below and never returned to the client.
      .select(
        'provider, model, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, handoff_agent_id, tools_enabled, max_tool_iterations, api_key, embeddings_api_key, transcription_provider, transcription_api_key, hours_enabled, hours_timezone, hours, daily_menu, onboarding_tested_at',
      )
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[ai/config GET] fetch error:', error)
      return NextResponse.json(
        { error: 'Failed to load AI configuration' },
        { status: 500 },
      )
    }

    if (!data) return NextResponse.json({ configured: false })
    // The keys are selected only to derive the has_* flags; none of
    // them is returned to the client.
    const { api_key, embeddings_api_key, transcription_api_key, onboarding_tested_at, ...safe } = data
    // OpenRouter transcription can run off the main chat key (see
    // loadTranscriptionConfig) — reflect that here too, so the
    // Settings form shows "configured" instead of nudging for a key
    // that isn't actually needed in that one case.
    const hasTranscriptionKey =
      !!transcription_api_key ||
      (data.transcription_provider === 'openrouter' && data.provider === 'openrouter' && !!api_key)
    return NextResponse.json({
      configured: true,
      has_key: !!api_key,
      has_embeddings_key: !!embeddings_api_key,
      has_transcription_key: hasTranscriptionKey,
      // Onboarding checklist's "tested in Playground" step — exposing
      // just the boolean, not the raw timestamp, keeps this route's
      // contract simple for the one caller that reads it.
      onboarding_tested: !!onboarding_tested_at,
      ...safe,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/config  (admin+)
 *
 * Upsert the account's AI config. Validates the key with the provider
 * before persisting (mirrors the WhatsApp config verifying with Meta
 * first), then stores the key AES-256-GCM-encrypted. When `api_key` is
 * omitted the existing stored key is reused (the form sends it only
 * when the user re-enters it).
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`ai-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const provider = body.provider as AiProvider
    if (!AI_PROVIDERS.includes(provider)) {
      return bad(`provider must be one of: ${AI_PROVIDERS.join(', ')}`)
    }
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!model) return bad('model is required')

    const systemPrompt =
      typeof body.system_prompt === 'string' && body.system_prompt.trim()
        ? body.system_prompt.trim()
        : null
    const isActive = body.is_active === true
    const autoReplyEnabled = body.auto_reply_enabled === true
    const toolsEnabled = body.tools_enabled === true

    let maxPer = Number(body.auto_reply_max_per_conversation)
    if (!Number.isFinite(maxPer)) maxPer = 3
    maxPer = Math.min(20, Math.max(1, Math.floor(maxPer)))

    // Per-account ceiling on tool round-trips within one auto-reply
    // turn (migration 067) — was a fixed global constant; a business
    // taking full orders via chat can need more than any one default
    // in a single turn (multi-item carts, clarifying re-asks), so this
    // is now theirs to raise in Settings instead of waiting on a code
    // deploy. Clamped the same way as maxPer above.
    let maxToolIter = Number(body.max_tool_iterations)
    if (!Number.isFinite(maxToolIter)) maxToolIter = MAX_TOOL_ITERATIONS_DEFAULT
    maxToolIter = Math.min(MAX_TOOL_ITERATIONS_CEILING, Math.max(1, Math.floor(maxToolIter)))

    // AI auto-reply's own schedule (migration 070) — independent of
    // delivery_business_hours; see auto-reply.ts's dispatch gate.
    const hoursEnabled = body.hours_enabled === true
    const hoursTimezone =
      typeof body.hours_timezone === 'string' && body.hours_timezone.trim()
        ? body.hours_timezone.trim()
        : 'America/Sao_Paulo'
    const hours = parseBusinessHoursWeek(body.hours ?? {})
    if (!hours) return bad('hours must be a map of day -> {open, close} | null')

    // Handoff routing target for auto-reply. A non-empty string must be a
    // member of this account (else the conversation would be assigned to a
    // stranger); an empty string / null means "leave unassigned" (the
    // shared queue). Absent → left unchanged on update below.
    const rawHandoff =
      typeof body.handoff_agent_id === 'string' ? body.handoff_agent_id.trim() : ''
    const handoffProvided = 'handoff_agent_id' in body
    let handoffAgentId: string | null = null
    if (rawHandoff) {
      const { data: member } = await supabase
        .from('profiles')
        .select('user_id')
        .eq('account_id', accountId)
        .eq('user_id', rawHandoff)
        .maybeSingle()
      if (!member) return bad('handoff_agent_id must be a member of this account')
      handoffAgentId = rawHandoff
    }

    const rawKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''

    // Embeddings key (optional, for semantic KB search): a non-empty
    // string sets/replaces it; an explicit null clears it; absent leaves
    // it unchanged. The form only sends it when the admin edits it.
    const rawEmbeddingsKey =
      typeof body.embeddings_api_key === 'string'
        ? body.embeddings_api_key.trim()
        : ''
    const clearEmbeddingsKey = body.embeddings_api_key === null

    // Transcription key (optional, for voice-note speech-to-text —
    // migration 069): same sparse set/clear/unchanged semantics as the
    // embeddings key above, plus the provider it's for. No live
    // validation round-trip here (unlike the chat/embeddings keys) —
    // there's no cheap "ping" input for a speech-to-text endpoint the
    // way there is for text/embeddings; an invalid key just surfaces
    // later as a logged, non-blocking failure on the next voice note
    // (see transcription.ts / the wuzapi webhook route).
    const rawTranscriptionKey =
      typeof body.transcription_api_key === 'string' ? body.transcription_api_key.trim() : ''
    const clearTranscriptionKey = body.transcription_api_key === null
    const transcriptionProvider =
      typeof body.transcription_provider === 'string' ? body.transcription_provider.trim() : ''
    if (transcriptionProvider && !['groq', 'openai', 'openrouter'].includes(transcriptionProvider)) {
      return bad('transcription_provider must be one of: groq, openai, openrouter')
    }

    // Reuse the stored key when the form didn't send a fresh one.
    const { data: existing } = await supabase
      .from('ai_configs')
      .select('id, provider, model, api_key')
      .eq('account_id', accountId)
      .maybeSingle()

    let apiKeyPlain: string
    if (rawKey) {
      apiKeyPlain = rawKey
    } else if (existing?.api_key) {
      try {
        apiKeyPlain = decrypt(existing.api_key)
      } catch {
        return bad('Stored API key could not be decrypted — re-enter your key.')
      }
    } else {
      return bad('api_key is required')
    }

    // Only spend a provider round-trip when the credentials that affect
    // reachability actually changed. A save that just flips a toggle or
    // edits the system prompt on an existing, already-validated config
    // skips the call — no wasted token/latency on the account's key.
    const credentialsChanged =
      !existing ||
      rawKey !== '' ||
      provider !== existing.provider ||
      model !== existing.model

    if (credentialsChanged) {
      try {
        await validateAiCredentials({
          provider,
          model,
          apiKey: apiKeyPlain,
          systemPrompt,
          isActive,
          autoReplyEnabled,
          autoReplyMaxPerConversation: maxPer,
          handoffAgentId: null,
          embeddingsApiKey: null,
          toolsEnabled,
          maxToolIterations: maxToolIter,
        })
      } catch (err) {
        if (err instanceof AiError) {
          return NextResponse.json(
            { error: err.message, code: err.code },
            { status: 400 },
          )
        }
        console.error('[ai/config POST] validation error:', err)
        return bad('Could not validate the API key with the provider.')
      }
    }

    // Validate a new embeddings key before storing (a cheap 1-input
    // embed), same "verify before save" discipline as the chat key.
    if (rawEmbeddingsKey) {
      try {
        await embedTexts(rawEmbeddingsKey, ['ping'])
      } catch (err) {
        if (err instanceof AiError) {
          return NextResponse.json(
            { error: `Embeddings key: ${err.message}`, code: err.code },
            { status: 400 },
          )
        }
        console.error('[ai/config POST] embeddings validation error:', err)
        return bad('Could not validate the embeddings key.')
      }
    }

    const encryptedKey = rawKey ? encrypt(rawKey) : null
    const shared: Record<string, unknown> = {
      provider,
      model,
      system_prompt: systemPrompt,
      is_active: isActive,
      auto_reply_enabled: autoReplyEnabled,
      auto_reply_max_per_conversation: maxPer,
      tools_enabled: toolsEnabled,
      max_tool_iterations: maxToolIter,
      hours_enabled: hoursEnabled,
      hours_timezone: hoursTimezone,
      hours,
    }
    // Only touch the handoff target when the form actually sent the field,
    // so a partial save (e.g. flipping a toggle) doesn't wipe it.
    if (handoffProvided) shared.handoff_agent_id = handoffAgentId
    if (rawEmbeddingsKey) {
      shared.embeddings_api_key = encrypt(rawEmbeddingsKey)
    } else if (clearEmbeddingsKey) {
      shared.embeddings_api_key = null
    }
    if ('transcription_provider' in body) shared.transcription_provider = transcriptionProvider || null
    if (rawTranscriptionKey) {
      shared.transcription_api_key = encrypt(rawTranscriptionKey)
    } else if (clearTranscriptionKey) {
      shared.transcription_api_key = null
    }

    if (existing) {
      const { error: upErr } = await supabase
        .from('ai_configs')
        .update(encryptedKey ? { ...shared, api_key: encryptedKey } : shared)
        .eq('account_id', accountId)
      if (upErr) {
        console.error('[ai/config POST] update error:', upErr)
        return NextResponse.json(
          { error: 'Failed to save AI configuration' },
          { status: 500 },
        )
      }
    } else {
      const { error: insErr } = await supabase.from('ai_configs').insert({
        account_id: accountId,
        created_by: userId,
        api_key: encryptedKey, // guaranteed non-null: rawKey required when no existing row
        ...shared,
      })
      if (insErr) {
        console.error('[ai/config POST] insert error:', insErr)
        return NextResponse.json(
          { error: 'Failed to save AI configuration' },
          { status: 500 },
        )
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/ai/config  (admin+)
 *
 * Removes the account's AI config (turns everything off and forgets the
 * key). Also used to recover from a corrupted encrypted key.
 */
export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { error } = await supabase
      .from('ai_configs')
      .delete()
      .eq('account_id', accountId)
    if (error) {
      console.error('[ai/config DELETE] error:', error)
      return NextResponse.json(
        { error: 'Failed to delete AI configuration' },
        { status: 500 },
      )
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
