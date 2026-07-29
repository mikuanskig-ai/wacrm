/**
 * WuzAPI helpers (github.com/asternic/wuzapi) — self-hosted WhatsApp
 * channel, alternative to the Meta Cloud API. WuzAPI wraps the
 * `whatsmeow` library and pairs like WhatsApp Web (QR code), no Meta
 * Business account needed.
 *
 * Mirrors meta-api.ts's named-args convention (single options object
 * per function) for the same reason: a typo surfaces as a TypeScript
 * error instead of a runtime rejection. Exported under the `wuzapiApi`
 * namespace by callers (`import * as wuzapiApi from './wuzapi-api'`)
 * to avoid colliding with meta-api.ts's same-named exports — the two
 * APIs share verb names (sendTextMessage, sendMediaMessage) but not
 * argument or response shapes (WuzAPI wants base64 data-URI media
 * bodies, not a fetchable link).
 *
 * Auth: every user-scoped WuzAPI call takes a `Token` header (the
 * per-connection token returned by POST /admin/users). Admin calls
 * (creating that user in the first place) take an `Authorization`
 * header with the server's admin token instead — see provisionUser
 * below.
 */

export interface WuzapiSendResult {
  messageId: string
}

interface WuzapiEnvelope<T> {
  code: number
  data: T
  success: boolean
}

interface WuzapiErrorEnvelope {
  code?: number
  error?: string
  success?: boolean
}

async function wuzapiRequest<T>(args: {
  baseUrl: string
  path: string
  method?: string
  /** `Token` header value (per-connection user token) or `Authorization` (admin). */
  authHeader: 'Token' | 'Authorization'
  authValue: string
  body?: unknown
}): Promise<T> {
  const { baseUrl, path, method = 'GET', authHeader, authValue, body } = args
  const url = `${baseUrl.replace(/\/$/, '')}${path}`
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      [authHeader]: authValue,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  let json: unknown
  try {
    json = await response.json()
  } catch {
    json = null
  }

  if (!response.ok || (json as WuzapiErrorEnvelope | null)?.success === false) {
    const message =
      (json as WuzapiErrorEnvelope | null)?.error ||
      `WuzAPI error: ${response.status}`
    throw new Error(message)
  }

  return (json as WuzapiEnvelope<T>).data
}

// ============================================================
// Admin — user provisioning
// ============================================================

export interface ProvisionUserArgs {
  /** Base URL of the operator's self-hosted WuzAPI server, e.g. http://localhost:8081. */
  baseUrl: string
  /** WUZAPI_ADMIN_TOKEN configured on that server. */
  adminToken: string
  /** Human label, shown in the ZonTalk settings UI and wuzapi's own admin list. */
  name: string
  /** The per-connection token ZonTalk generates and asks wuzapi to assign this user. */
  token: string
  webhookUrl: string
}

export interface ProvisionUserResult {
  /** WuzAPI returns this as a string (a hex id), not a number. */
  id: string
}

/**
 * Create a new WuzAPI user (= one WhatsApp connection slot) via the
 * admin API. ZonTalk generates `token` itself (a random string) rather
 * than letting WuzAPI assign one, so it's known up front and can be
 * encrypted + hashed into `whatsapp_config` in the same request that
 * creates the row.
 */
export async function provisionUser(
  args: ProvisionUserArgs,
): Promise<ProvisionUserResult> {
  const { baseUrl, adminToken, name, token, webhookUrl } = args
  return wuzapiRequest<ProvisionUserResult>({
    baseUrl,
    path: '/admin/users',
    method: 'POST',
    authHeader: 'Authorization',
    authValue: adminToken,
    body: { name, token, webhook: webhookUrl, events: 'Message,ReadReceipt' },
  })
}

// ============================================================
// Session lifecycle
// ============================================================

export interface WuzapiSessionArgs {
  baseUrl: string
  token: string
}

/**
 * Configure the per-connection HMAC key used to sign inbound webhook
 * deliveries. Called once at provisioning time — see
 * wuzapi-webhook-signature.ts for verification on the receiving end.
 */
export async function configureHmacKey(
  args: WuzapiSessionArgs & { hmacKey: string },
): Promise<void> {
  const { baseUrl, token, hmacKey } = args
  await wuzapiRequest({
    baseUrl,
    path: '/session/hmac/config',
    method: 'POST',
    authHeader: 'Token',
    authValue: token,
    body: { hmac_key: hmacKey },
  })
}

/**
 * Start (or resume) the WhatsApp connection. `Immediate: false` makes
 * WuzAPI wait ~10s to confirm login before returning, but the caller
 * still needs to poll /session/status afterwards — a session can drop
 * shortly after connect if it was previously terminated from the
 * phone. ZonTalk always passes Immediate: true and polls status/qr from
 * the client instead, so the pairing UI can show a live QR code rather
 * than blocking the request for 10s.
 */
export async function connectSession(args: WuzapiSessionArgs): Promise<void> {
  const { baseUrl, token } = args
  await wuzapiRequest({
    baseUrl,
    path: '/session/connect',
    method: 'POST',
    authHeader: 'Token',
    authValue: token,
    body: { Subscribe: ['Message', 'ReadReceipt'], Immediate: true },
  })
}

export interface WuzapiStatus {
  // Bundled OpenAPI spec (/app/static/api/spec.yml) documents these as
  // `Connected`/`LoggedIn`, but the actually-deployed asternic/wuzapi
  // build returns lowercase — confirmed against live traffic. Matching
  // the real runtime shape, not the (stale, for this build) docs.
  connected: boolean
  loggedIn: boolean
}

export async function getSessionStatus(
  args: WuzapiSessionArgs,
): Promise<WuzapiStatus> {
  const { baseUrl, token } = args
  return wuzapiRequest<WuzapiStatus>({
    baseUrl,
    path: '/session/status',
    authHeader: 'Token',
    authValue: token,
  })
}

export interface WuzapiQrCode {
  /** `data:image/png;base64,...` — render directly in an <img src>. */
  QRCode: string
}

/**
 * Fetch the pairing QR code. Only returns a value once the session is
 * connected and not yet logged in — poll this alongside
 * getSessionStatus while the UI is in the `qr_pending` state.
 */
export async function getQrCode(args: WuzapiSessionArgs): Promise<WuzapiQrCode> {
  const { baseUrl, token } = args
  return wuzapiRequest<WuzapiQrCode>({
    baseUrl,
    path: '/session/qr',
    authHeader: 'Token',
    authValue: token,
  })
}

/** Ends the WhatsApp session — a fresh QR scan is required afterwards. */
export async function logoutSession(args: WuzapiSessionArgs): Promise<void> {
  const { baseUrl, token } = args
  await wuzapiRequest({
    baseUrl,
    path: '/session/logout',
    method: 'POST',
    authHeader: 'Token',
    authValue: token,
  })
}

/** Registers ZonTalk's wuzapi webhook route on the WuzAPI server. */
export async function setWebhook(
  args: WuzapiSessionArgs & { webhookUrl: string },
): Promise<void> {
  const { baseUrl, token, webhookUrl } = args
  await wuzapiRequest({
    baseUrl,
    path: '/webhook',
    method: 'POST',
    authHeader: 'Token',
    authValue: token,
    body: { webhookURL: webhookUrl },
  })
}

// ============================================================
// Sending
// ============================================================

export interface SendTextMessageArgs {
  baseUrl: string
  token: string
  to: string
  text: string
}

/** Send a free-form text message. `to` is a bare MSISDN (no `+`, no spaces). */
export async function sendTextMessage(
  args: SendTextMessageArgs,
): Promise<WuzapiSendResult> {
  const { baseUrl, token, to, text } = args
  const data = await wuzapiRequest<{ Id: string }>({
    baseUrl,
    path: '/chat/send/text',
    method: 'POST',
    authHeader: 'Token',
    authValue: token,
    body: { Phone: to, Body: text },
  })
  return { messageId: data.Id }
}

export type WuzapiMediaKind = 'image' | 'video' | 'document' | 'audio' | 'sticker'

const MEDIA_ENDPOINT: Record<WuzapiMediaKind, string> = {
  image: '/chat/send/image',
  video: '/chat/send/video',
  document: '/chat/send/document',
  audio: '/chat/send/audio',
  sticker: '/chat/send/sticker',
}

// WuzAPI's send-media payload key differs per kind (Image/Video/…),
// and only document takes FileName / only image+video take Caption.
const MEDIA_FIELD: Record<WuzapiMediaKind, string> = {
  image: 'Image',
  video: 'Video',
  document: 'Document',
  audio: 'Audio',
  sticker: 'Sticker',
}

export interface SendMediaMessageArgs {
  baseUrl: string
  token: string
  to: string
  kind: WuzapiMediaKind
  /** `data:<mime>;base64,<...>` — WuzAPI takes the media inline, not a URL. */
  dataUri: string
  caption?: string
  filename?: string
}

/**
 * Send an image/video/document/audio/sticker. Unlike Meta's
 * link-fetch model, WuzAPI wants the bytes embedded as a base64 data
 * URI in the request body — the caller (send-message.ts) is
 * responsible for fetching `mediaUrl` and base64-encoding it before
 * calling this.
 */
export async function sendMediaMessage(
  args: SendMediaMessageArgs,
): Promise<WuzapiSendResult> {
  const { baseUrl, token, to, kind, dataUri, caption, filename } = args
  const body: Record<string, unknown> = {
    Phone: to,
    [MEDIA_FIELD[kind]]: dataUri,
  }
  // Per WuzAPI's API.md: audio accepts neither Caption nor FileName;
  // only document accepts FileName; image/video accept Caption.
  if (caption && kind !== 'audio' && kind !== 'sticker') body.Caption = caption
  if (kind === 'document' && filename) body.FileName = filename

  const data = await wuzapiRequest<{ Id: string }>({
    baseUrl,
    path: MEDIA_ENDPOINT[kind],
    method: 'POST',
    authHeader: 'Token',
    authValue: token,
    body,
  })
  return { messageId: data.Id }
}

// ============================================================
// Inbound media — download + decrypt
//
// A media message arriving over the webhook (`/chat/downloadimage`
// etc. — confirmed against WuzAPI's own OpenAPI spec at GET /api/spec.yml,
// definitions.DownloadMedia) carries only an ENCRYPTED reference
// (`Url`/`DirectPath` pointing at mmg.whatsapp.net, plus `MediaKey` to
// derive the decryption key) — never inline bytes. WuzAPI does the
// AES decrypt server-side; this just calls that endpoint and hands
// back a data URI, mirroring `sendMediaMessage`'s shape in reverse.
// ============================================================

export type WuzapiDownloadKind = 'image' | 'video' | 'audio' | 'document' | 'sticker'

const DOWNLOAD_ENDPOINT: Record<WuzapiDownloadKind, string> = {
  image: '/chat/downloadimage',
  video: '/chat/downloadvideo',
  audio: '/chat/downloadaudio',
  document: '/chat/downloaddocument',
  sticker: '/chat/downloadsticker',
}

export interface DownloadMediaArgs {
  baseUrl: string
  token: string
  kind: WuzapiDownloadKind
  /** Encrypted media reference fields, straight off the webhook's
   *  `<kind>Message` object — see the `WuzapiWebhookPayload` shape in
   *  the wuzapi webhook route. */
  url: string
  directPath?: string
  mediaKey: string
  mimetype: string
  fileEncSha256?: string
  fileSha256: string
  fileLength: number
}

export interface DownloadMediaResult {
  /** `data:<mime>;base64,<...>` */
  dataUri: string
  mimetype: string
}

export async function downloadMedia(args: DownloadMediaArgs): Promise<DownloadMediaResult> {
  const { baseUrl, token, kind, url, directPath, mediaKey, mimetype, fileEncSha256, fileSha256, fileLength } = args
  const body: Record<string, unknown> = {
    Url: url,
    MediaKey: mediaKey,
    Mimetype: mimetype,
    FileSHA256: fileSha256,
    FileLength: fileLength,
  }
  if (directPath) body.DirectPath = directPath
  if (fileEncSha256) body.FileEncSHA256 = fileEncSha256

  const data = await wuzapiRequest<{ Data: string; Mimetype: string }>({
    baseUrl,
    path: DOWNLOAD_ENDPOINT[kind],
    method: 'POST',
    authHeader: 'Token',
    authValue: token,
    body,
  })
  return { dataUri: data.Data, mimetype: data.Mimetype }
}
