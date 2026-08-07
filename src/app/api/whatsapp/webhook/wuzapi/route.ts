import { NextResponse, after } from 'next/server'
import crypto from 'node:crypto'
import { decrypt } from '@/lib/whatsapp/encryption'
import { verifyWuzapiWebhookSignature } from '@/lib/whatsapp/wuzapi-webhook-signature'
import * as wuzapiApi from '@/lib/whatsapp/wuzapi-api'
import {
  supabaseAdmin,
  processMessage,
  processOutboundEchoMessage,
  type WhatsAppMessage,
  type ParsedContent,
} from '@/lib/whatsapp/inbound-message'
import { isAccountSuspended } from '@/lib/accounts/suspension'
import { loadTranscriptionConfig } from '@/lib/ai/config'
import { transcribeAudio } from '@/lib/ai/transcription'

/** Strip any `; params` off a MIME type (WhatsApp sends audio as
 *  `"audio/ogg; codecs=opus"`, but Storage bucket allowlists and file
 *  extensions both need the bare `type/subtype`). */
function baseMimeType(mimetype: string): string {
  return mimetype.split(';')[0]!.trim()
}

export const maxDuration = 60

// ============================================================
// WuzAPI webhook payload shape — confirmed against live traffic from
// a paired session (2026-07-27). Differs from the API.md docs (which
// only cover registration, not delivery) in three important ways:
//
//   1. No `token` field. The connection is identified by `userID` —
//      WuzAPI's own internal user id (same value as `data.id` from
//      `POST /admin/users` at provisioning time). Routing is
//      `.eq('wuzapi_user_id', payload.userID)`, not a token hash.
//   2. `event.Info.Timestamp` is an ISO 8601 string
//      ("2026-07-27T18:03:12-03:00"), not a Unix epoch number.
//   3. `event.Info.Sender` can be an opaque `@lid` identifier (newer
//      WhatsApp "linked id" addressing, common in groups) — the real
//      phone-number JID is in `event.Info.SenderAlt` when present.
//      Always prefer SenderAlt.
//   4. `event.Info.IsGroup` is NOT a reliable "is this a real WhatsApp
//      group" signal — a captured live Status/Story broadcast came in
//      with `IsGroup: true` AND `Chat: "status@broadcast"`. The only
//      trustworthy discriminator is the `Chat` field's JID domain:
//      `@s.whatsapp.net`/`@lid` = private 1:1, `@g.us` = real group,
//      `status@broadcast` = Status/Story, `@newsletter` = Channel.
//      See the allowlist in parseWuzapiEvent below.
//   5. Media messages (image/video/audio/document) never carry inline
//      bytes — only an AES-encrypted `URL`/`mediaKey` reference (same
//      shape whatsmeow itself uses). Getting the actual bytes requires
//      calling WuzAPI's own `/chat/download*` endpoints (see
//      `wuzapiApi.downloadMedia`), which decrypt server-side and
//      return a base64 data URI — confirmed via a real image/audio
//      send (2026-07-28).
//
// Top-level shape: { event: { Info, Message, ... }, instanceName,
// type: "Message", userID }.
// ============================================================

interface WuzapiWebhookPayload {
  userID?: string
  type?: string
  event?: {
    Info?: {
      Sender?: string
      SenderAlt?: string
      /**
       * Only populated on an `IsFromMe` echo — the real phone-number
       * JID of the OTHER party. On those events `Sender`/`SenderAlt`
       * point at our own account (often an opaque `@lid`), so the
       * counterparty has to be read from here instead. Confirmed
       * against live traffic (2026-07-29): a message sent from the
       * paired phone itself, outside the platform, arrived with
       * `SenderAlt: ""` and `RecipientAlt` set to the real contact.
       */
      RecipientAlt?: string
      /**
       * Destination chat JID — confirmed against live traffic (a
       * Status/Story broadcast arrived as `"status@broadcast"`, with
       * `IsGroup: true` alongside it, proving `IsGroup` alone can't
       * distinguish a real group from other non-1:1 chat kinds). This
       * is the field the private-chat allowlist checks.
       */
      Chat?: string
      ID?: string
      Timestamp?: string
      PushName?: string
      IsFromMe?: boolean
      IsGroup?: boolean
    }
    Message?: {
      conversation?: string
      extendedTextMessage?: { text?: string }
      imageMessage?: WuzapiEncryptedMediaFields & { caption?: string }
      videoMessage?: WuzapiEncryptedMediaFields & { caption?: string }
      audioMessage?: WuzapiEncryptedMediaFields
      documentMessage?: WuzapiEncryptedMediaFields & { caption?: string; fileName?: string }
      locationMessage?: { degreesLatitude?: number; degreesLongitude?: number; name?: string; address?: string }
    }
  }
}

/**
 * Encrypted media reference fields whatsmeow attaches to every media
 * message (confirmed against live traffic — an image/audio send from
 * a real device — 2026-07-28). There is NO inline `base64` field: the
 * `URL` points at an AES-encrypted blob on mmg.whatsapp.net, and
 * `mediaKey` is what WuzAPI's own `/chat/download*` endpoints need to
 * decrypt it server-side (see `downloadMedia` in wuzapi-api.ts).
 */
interface WuzapiEncryptedMediaFields {
  URL?: string
  directPath?: string
  mediaKey?: string
  mimetype?: string
  fileEncSHA256?: string
  fileSHA256?: string
  fileLength?: number
}

function bareJidToPhone(jid: string | undefined): string {
  if (!jid) return ''
  // "5491155554444.0:12@s.whatsapp.net" or "5491155554444@s.whatsapp.net"
  return jid.split('@')[0].split('.')[0].split(':')[0]
}

async function parseWuzapiEvent(
  payload: WuzapiWebhookPayload,
): Promise<{ message: WhatsAppMessage; content: ParsedContent; pushName: string | null; isFromMe: boolean } | null> {
  if (payload.type !== 'Message' || !payload.event?.Info || !payload.event.Message) {
    return null
  }
  const { Info, Message } = payload.event
  // `IsFromMe` = the agent sent this straight from their own paired
  // phone, outside the platform — no longer dropped (that used to
  // silently break the inbox thread for anyone messaging a contact
  // directly from WhatsApp instead of the dashboard). The caller
  // routes these into processOutboundEchoMessage instead of the
  // normal customer-inbound path.
  const isFromMe = Boolean(Info.IsFromMe)

  // Allowlist, not a blocklist: only genuine 1:1 conversations create a
  // ticket. Everything else — groups (@g.us), Status/Stories
  // (status@broadcast), Channels/Communities (@newsletter), and any
  // future/unknown chat-JID domain — is dropped by default. This CRM's
  // contact/conversation model is 1:1-only; group support is an
  // explicitly separate later phase. `IsGroup` is kept as a redundant
  // fast-path check first (belt-and-suspenders, same style as the
  // status:'pending' DEFAULT + explicit insert elsewhere in this
  // codebase) but the real discriminator is the `Chat` JID domain,
  // since IsGroup alone doesn't distinguish a real group from a Status
  // broadcast (confirmed against live traffic — see the interface
  // comment above).
  if (Info.IsGroup) return null
  // `Info.Chat` was only confirmed present on a Status/Story event so
  // far — if a future payload shape ever omits it on a genuine 1:1
  // message, fail open (don't drop) rather than silently blocking real
  // customer messages; the known-bad domains below are still caught
  // whenever `Chat` IS present.
  const chatDomain = (Info.Chat ?? '').split('@')[1] ?? ''
  if (chatDomain) {
    const isPrivateChat = chatDomain === 's.whatsapp.net' || chatDomain === 'lid'
    if (!isPrivateChat) {
      console.warn('[wuzapi-webhook] dropping non-1:1 chat:', chatDomain)
      return null
    }
  }

  const id = Info.ID || crypto.randomUUID()
  const timestamp = String(
    Math.floor(new Date(Info.Timestamp ?? Date.now()).getTime() / 1000),
  )
  // Prefer SenderAlt — the real phone-number JID. Plain `Sender` can
  // be an opaque `@lid` (linked-id) identifier that isn't a phone
  // number at all, which would corrupt contact matching. On an
  // `IsFromMe` echo, Sender/SenderAlt are OUR OWN account instead —
  // the counterparty phone lives in RecipientAlt (falling back to
  // Chat, which at least identifies the conversation even if it's an
  // opaque @lid with no phone-number form available).
  const from = isFromMe
    ? bareJidToPhone(Info.RecipientAlt || Info.Chat)
    : bareJidToPhone(Info.SenderAlt || Info.Sender)
  // Info.PushName is OUR OWN profile name on an IsFromMe echo — using
  // it here would rename the contact to the agent's own name the next
  // time findOrCreateContact runs, so echoes never carry a name at
  // all. Same for a genuine inbound message with no PushName: `null`,
  // not a phone-number placeholder — findOrCreateContact treats any
  // truthy name as "we really learned this," so handing it a
  // phone-shaped fallback here previously reset a contact's real,
  // already-known name to their bare phone number on the very next
  // IsFromMe echo or no-PushName event (confirmed live 2026-07-31).
  // The phone-as-name fallback still applies, but only once, on
  // brand-new contact INSERT (see findOrCreateContact).
  const pushName = isFromMe ? null : Info.PushName || null

  const base: WhatsAppMessage = { id, from, timestamp, type: 'text' }

  if (Message.conversation || Message.extendedTextMessage?.text) {
    return {
      message: { ...base, type: 'text' },
      content: {
        contentText: Message.conversation || Message.extendedTextMessage?.text || null,
        mediaUrl: null,
        mediaType: null,
        interactiveReplyId: null,
      },
      pushName,
      isFromMe,
    }
  }

  // Media types — the actual download-and-decrypt + Supabase Storage
  // upload happens in POST once `config.account_id` (for the storage
  // path) and `config.wuzapi_token` (to call WuzAPI's own
  // /chat/download* endpoints) are known; this function only
  // classifies the message and carries the encrypted media reference
  // through. Confirmed against live traffic (2026-07-28): WuzAPI never
  // sends inline base64 here — only an encrypted `URL`/`mediaKey` pair
  // that must be exchanged for bytes via `wuzapiApi.downloadMedia`.
  if (Message.imageMessage) {
    return {
      message: { ...base, type: 'image' },
      content: {
        contentText: Message.imageMessage.caption || null,
        mediaUrl: null, // resolved by the caller once accountId is known
        mediaType: Message.imageMessage.mimetype || null,
        interactiveReplyId: null,
      },
      pushName,
      isFromMe,
    }
  }
  if (Message.videoMessage) {
    return {
      message: { ...base, type: 'video' },
      content: {
        contentText: Message.videoMessage.caption || null,
        mediaUrl: null,
        mediaType: Message.videoMessage.mimetype || null,
        interactiveReplyId: null,
      },
      pushName,
      isFromMe,
    }
  }
  if (Message.audioMessage) {
    return {
      message: { ...base, type: 'audio' },
      content: { contentText: null, mediaUrl: null, mediaType: Message.audioMessage.mimetype || null, interactiveReplyId: null },
      pushName,
      isFromMe,
    }
  }
  if (Message.documentMessage) {
    return {
      message: { ...base, type: 'document' },
      content: {
        contentText: Message.documentMessage.caption || Message.documentMessage.fileName || null,
        mediaUrl: null,
        mediaType: Message.documentMessage.mimetype || null,
        interactiveReplyId: null,
      },
      pushName,
      isFromMe,
    }
  }
  if (Message.locationMessage) {
    const loc = Message.locationMessage
    const locationText = [loc.name, loc.address, `${loc.degreesLatitude},${loc.degreesLongitude}`]
      .filter(Boolean)
      .join(' - ')
    return {
      message: { ...base, type: 'location' },
      content: { contentText: locationText, mediaUrl: null, mediaType: null, interactiveReplyId: null },
      pushName,
      isFromMe,
    }
  }

  console.warn('[wuzapi-webhook] unrecognized message shape, dropping:', JSON.stringify(Message).slice(0, 300))
  return null
}

export async function POST(request: Request) {
  const rawBody = await request.text()
  const signatureHeader = request.headers.get('x-hmac-signature')

  let payload: WuzapiWebhookPayload
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!payload.userID) {
    return NextResponse.json({ error: 'Missing userID' }, { status: 400 })
  }

  const { data: config, error: configError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('*')
    .eq('wuzapi_user_id', payload.userID)
    .eq('channel_type', 'wuzapi')
    .maybeSingle()

  if (configError) {
    console.error('[wuzapi-webhook] config lookup failed:', configError)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
  if (!config) {
    console.warn('[wuzapi-webhook] no config found for userID — rejecting')
    return NextResponse.json({ error: 'Unknown connection' }, { status: 404 })
  }

  const hmacKey = config.wuzapi_hmac_key ? decrypt(config.wuzapi_hmac_key) : null
  if (!verifyWuzapiWebhookSignature(rawBody, signatureHeader, hmacKey)) {
    console.warn('[wuzapi-webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // Migration 062 — a suspended account gets no processing at all
  // (no message stored, no AI/Flow/automation triggered). Ack with
  // 200 so WuzAPI doesn't treat this as a delivery failure and retry.
  if (await isAccountSuspended(supabaseAdmin(), config.account_id)) {
    return NextResponse.json({ ok: true })
  }

  after(async () => {
    try {
      const parsed = await parseWuzapiEvent(payload)
      if (!parsed) return

      const { message, content, pushName, isFromMe } = parsed

      // Media messages need accountId to build the storage path — the
      // parser above returns mediaUrl: null for those; resolve it here
      // now that config.account_id is known, then fall through to the
      // same processMessage() the Meta route uses.
      let resolvedContent = content
      const mediaField = (
        payload.event?.Message as
          | Record<string, WuzapiEncryptedMediaFields | undefined>
          | undefined
      )?.[`${message.type}Message`]
      const isDownloadableKind =
        message.type === 'image' ||
        message.type === 'video' ||
        message.type === 'audio' ||
        message.type === 'document'
      if (
        isDownloadableKind &&
        mediaField?.URL &&
        mediaField.mediaKey &&
        mediaField.fileSHA256 &&
        mediaField.fileLength
      ) {
        try {
          // The webhook only carries an ENCRYPTED reference (URL +
          // mediaKey) — WuzAPI's own /chat/download* endpoints do the
          // AES decrypt server-side and hand back a base64 data URI.
          const downloaded = await wuzapiApi.downloadMedia({
            baseUrl: config.wuzapi_base_url as string,
            token: decrypt(config.wuzapi_token as string),
            kind: message.type as wuzapiApi.WuzapiDownloadKind,
            url: mediaField.URL,
            directPath: mediaField.directPath,
            mediaKey: mediaField.mediaKey,
            mimetype: mediaField.mimetype || 'application/octet-stream',
            fileEncSha256: mediaField.fileEncSHA256,
            fileSha256: mediaField.fileSHA256,
            fileLength: mediaField.fileLength,
          })
          const mimetype = baseMimeType(downloaded.mimetype || mediaField.mimetype || 'application/octet-stream')
          const commaIdx = downloaded.dataUri.indexOf(',')
          const buffer = Buffer.from(
            commaIdx >= 0 ? downloaded.dataUri.slice(commaIdx + 1) : downloaded.dataUri,
            'base64',
          )
          const ext = mimetype.split('/')[1] || 'bin'
          // `account-<id>/...` prefix matches the chat-media storage
          // RLS policy's foldername check (migration 023) — the
          // service-role client bypasses RLS anyway, but keeping the
          // same layout means admin tooling that assumes this
          // convention still finds these files.
          const path = `account-${config.account_id}/${crypto.randomUUID()}.${ext}`
          const { error: upErr } = await supabaseAdmin()
            .storage.from('chat-media')
            .upload(path, buffer, { contentType: mimetype })
          if (!upErr) {
            const { data: pub } = supabaseAdmin().storage.from('chat-media').getPublicUrl(path)
            resolvedContent = { ...content, mediaUrl: pub.publicUrl }

            // Transcribe inbound voice notes when the account opted in
            // (migration 069) — runs here, before processMessage()
            // below, so the transcript lands in content_text in time
            // for both the inbox (human agents read it as a caption)
            // and the AI (buildConversationContext only sees content_
            // type 'text'/'audio' rows that actually have text — see
            // context.ts). Never blocks message ingestion: any failure
            // here just leaves this voice note without a transcript,
            // exactly like today.
            if (message.type === 'audio') {
              try {
                const transcription = await loadTranscriptionConfig(supabaseAdmin(), config.account_id)
                if (transcription) {
                  const transcript = await transcribeAudio(
                    transcription.provider,
                    transcription.apiKey,
                    buffer,
                    mimetype,
                  )
                  if (transcript) resolvedContent = { ...resolvedContent, contentText: transcript }
                }
              } catch (err) {
                console.error('[wuzapi-webhook] audio transcription failed:', err)
              }
            }
          } else {
            console.error('[wuzapi-webhook] media upload failed:', upErr.message)
          }
        } catch (err) {
          console.error('[wuzapi-webhook] media download/decrypt failed:', err)
        }
      }

      // Lazy — findOrCreateContact only calls this the one time it
      // actually creates a new contact row, so an existing contact's
      // every subsequent message doesn't pay for a WuzAPI round trip.
      // The CDN URL WuzAPI hands back is signed/time-limited, so it's
      // downloaded and re-hosted on our own Storage rather than stored
      // as-is (same pattern as inbound media above).
      const fetchAvatarUrl = async (): Promise<string | null> => {
        const avatar = await wuzapiApi.getAvatar({
          baseUrl: config.wuzapi_base_url as string,
          token: decrypt(config.wuzapi_token as string),
          phone: message.from,
        })
        // getAvatar() already warns on its own failure — the branches
        // below log too, since "contact photos aren't showing" was
        // previously undiagnosable from logs (every failure point here
        // was silent).
        if (!avatar?.url) return null
        const res = await fetch(avatar.url)
        if (!res.ok) {
          console.warn(`[wuzapi-webhook] avatar CDN fetch failed for ${message.from}: ${res.status}`)
          return null
        }
        const contentType = baseMimeType(res.headers.get('content-type') || 'image/jpeg')
        const ext = contentType.split('/')[1] || 'jpg'
        const bytes = Buffer.from(await res.arrayBuffer())
        const path = `account-${config.account_id}/avatars/${crypto.randomUUID()}.${ext}`
        const { error: upErr } = await supabaseAdmin()
          .storage.from('chat-media')
          .upload(path, bytes, { contentType })
        if (upErr) {
          console.warn(`[wuzapi-webhook] avatar storage upload failed for ${message.from}:`, upErr.message)
          return null
        }
        const { data: pub } = supabaseAdmin().storage.from('chat-media').getPublicUrl(path)
        return pub.publicUrl
      }

      if (isFromMe) {
        // Agent sent this straight from their own paired phone,
        // outside the dashboard — thread it into the same
        // conversation as an agent message instead of dropping it, so
        // the inbox history stays complete no matter which side
        // messaged first.
        await processOutboundEchoMessage(
          message,
          { profile: { name: pushName }, wa_id: message.from },
          config.account_id,
          config.user_id,
          resolvedContent,
          fetchAvatarUrl,
        )
      } else {
        await processMessage(
          message,
          { profile: { name: pushName }, wa_id: message.from },
          config.account_id,
          config.user_id,
          resolvedContent,
          fetchAvatarUrl,
        )
      }
    } catch (error) {
      console.error('[wuzapi-webhook] error processing event:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}
