import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  generateReplyWithTools: vi.fn(),
  getAccountCurrency: vi.fn(),
  engineSendText: vi.fn(),
  sleep: vi.fn(),
  getPixKey: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    enabledModules: [] as string[],
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
    // null = no AI-hours row configured — getAiBusinessHours returns
    // null, same as today's behavior (no hours gate at all).
    aiHours: null as { hours_enabled: boolean; hours_timezone: string; hours: unknown } | null,
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({
  generateReply: h.generateReply,
  generateReplyWithTools: h.generateReplyWithTools,
}))
vi.mock('./debounce', () => ({ sleep: h.sleep }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
vi.mock('@/lib/flows/engine', () => ({ getAccountCurrency: h.getAccountCurrency }))
vi.mock('@/lib/payments/config', () => ({ getPixKey: h.getPixKey }))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      if (table === 'accounts') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: { enabled_modules: h.state.enabledModules },
                  error: null,
                }),
            }),
          }),
        }
      }
      if (table === 'ai_configs') {
        // Only the hours-gate query in this module (getAiBusinessHours)
        // hits ai_configs directly — loadAiConfig itself is mocked above.
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: h.state.aiHours, error: null }),
            }),
          }),
        }
      }
      // conversations
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conv, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
  inboundMessageId: 'wamid-1',
  inboundSeq: 1,
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    toolsEnabled: false,
    maxToolIterations: 10,
    ...overrides,
  }
}

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
    ai_inbound_seq: 1,
  }
  h.state.autoResponders = []
  h.state.claim = true
  h.state.enabledModules = []
  h.state.updatePayload = null
  h.state.rpcCalls = []
  h.state.aiHours = null
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.getPixKey.mockResolvedValue(null)
  h.generateReplyWithTools.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.getAccountCurrency.mockResolvedValue('BRL')
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  // No real delay in tests — the debounce's actual timing isn't under
  // test here (that's covered by the seq-mismatch behavior below).
  h.sleep.mockResolvedValue(undefined)
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips silently — no auto-message — when outside the account-configured AI hours', async () => {
    // Empty `hours` = closed every day (same convention as
    // business-hours.test.ts) — deterministic regardless of when this
    // test actually runs, no fake timers needed.
    h.state.aiHours = { hours_enabled: true, hours_timezone: 'UTC', hours: {} }
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toBeNull() // no handoff/state write either — true silence
  })

  it('ignores a configured hours schedule when hours_enabled is false', async () => {
    h.state.aiHours = { hours_enabled: false, hours_timezone: 'UTC', hours: {} }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the ticket is in the ABERTO bucket (status=open), even if unassigned', async () => {
    h.state.conv = {
      status: 'open',
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — burst debounce', () => {
  it('waits out the debounce window before generating', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.sleep).toHaveBeenCalledWith(expect.any(Number))
    expect(h.generateReply).toHaveBeenCalled()
  })

  it('stands down — no generation, no send — when a newer inbound bumped the seq during the debounce wait', async () => {
    h.sleep.mockImplementation(async () => {
      // Simulate a second customer message landing while this
      // dispatch was "waiting" — its own dispatch owns the reply now.
      h.state.conv = { ...(h.state.conv as object), ai_inbound_seq: 2 }
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not send a reply that went stale mid-generation (newer inbound arrived while the provider call was in flight)', async () => {
    h.generateReply.mockImplementation(async () => {
      h.state.conv = { ...(h.state.conv as object), ai_inbound_seq: 2 }
      return { text: 'Hello!', handoff: false }
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('still sends the order confirmation when generation goes stale AFTER a real order was placed', async () => {
    h.state.enabledModules = ['delivery']
    h.loadAiConfig.mockResolvedValue(aiConfig({ toolsEnabled: true }))
    h.generateReplyWithTools.mockImplementation(async () => {
      h.state.conv = { ...(h.state.conv as object), ai_inbound_seq: 2 }
      return {
        text: '',
        handoff: false,
        usage: null,
        placedOrder: {
          id: 'order-1',
          total: 42,
          currency: 'BRL',
          items: [{ product_name: 'Pizza', quantity: 1, line_total: 42 }],
        },
      }
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Pizza') }),
    )
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('disables auto-reply, writes a summary, and does not send on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('routes to the configured handoff agent on handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })

  it('hands off to a human — instead of silently dropping the thread — when the provider call itself throws', async () => {
    h.generateReply.mockRejectedValue(new Error('Gemini rate limit reached: quota exceeded'))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain('provider error')
  })
})

describe('dispatchInboundToAiReply — tool-calling path', () => {
  beforeEach(() => {
    h.state.enabledModules = ['delivery']
    h.loadAiConfig.mockResolvedValue(aiConfig({ toolsEnabled: true }))
  })

  it('claims a tool turn keyed on the inbound message id before generating', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls[0]).toMatchObject({
      name: 'claim_ai_tool_turn',
      args: { conversation_id: 'conv-1', message_id: 'wamid-1' },
    })
    expect(h.generateReplyWithTools).toHaveBeenCalled()
    expect(h.generateReply).not.toHaveBeenCalled()
  })

  it('stands down silently — no generation, no send — when the turn was already claimed', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.generateReplyWithTools).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('sends a deterministic order-confirmation text on a placed order, never the model for that message', async () => {
    h.generateReplyWithTools.mockResolvedValue({
      text: '',
      handoff: false,
      usage: null,
      placedOrder: {
        id: 'order-1',
        total: 42,
        currency: 'BRL',
        items: [{ product_name: 'Pizza', quantity: 1, line_total: 42 }],
      },
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Pizza') }),
    )
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Seu pedido foi enviado para a cozinha.') }),
    )
  })

  it('appends the account\'s Pix key when the order was paid via Pix — regression, 2026-08-09', async () => {
    h.getPixKey.mockResolvedValue('45999526657')
    h.generateReplyWithTools.mockResolvedValue({
      text: '',
      handoff: false,
      usage: null,
      placedOrder: {
        id: 'order-1',
        total: 42,
        deliveryFee: 0,
        currency: 'BRL',
        items: [{ product_name: 'Pizza', quantity: 1, line_total: 42 }],
        paymentMethod: 'Pix',
      },
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Chave Pix para pagamento: 45999526657') }),
    )
  })

  it('never looks up or appends a Pix key when the payment method is not Pix', async () => {
    h.getPixKey.mockResolvedValue('45999526657')
    h.generateReplyWithTools.mockResolvedValue({
      text: '',
      handoff: false,
      usage: null,
      placedOrder: {
        id: 'order-1',
        total: 42,
        deliveryFee: 0,
        currency: 'BRL',
        items: [{ product_name: 'Pizza', quantity: 1, line_total: 42 }],
        paymentMethod: 'Cartão na entrega',
      },
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.not.stringContaining('Chave Pix') }),
    )
  })

  it('skips silently — not a sticky handoff — when the loop reports rateLimited', async () => {
    h.generateReplyWithTools.mockResolvedValue({
      text: '',
      handoff: false,
      usage: null,
      rateLimited: true,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toBeNull()
  })

  it('clears ai_cart when the tool-enabled path hands off', async () => {
    h.generateReplyWithTools.mockResolvedValue({ text: '', handoff: true, usage: null })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      ai_cart: [],
    })
  })

  it('blocks a hallucinated order summary — "Total" + a price, but the cart is empty — and hands off instead of sending it', async () => {
    // Regression, 2026-08-17/19 (Concórdia — Francisco/Ederson/Juan): the
    // model composed a fully convincing itemized summary with nothing
    // behind it (ai_cart still []).
    h.generateReplyWithTools.mockResolvedValue({
      text: 'Confirmando seu pedido:\n* 2 marmitas G\n* Subtotal: R$56\n* Total: R$64\nPosso confirmar?',
      handoff: false,
      usage: null,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true, ai_cart: [] })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain('without a real order behind it')
  })

  it('does not block a real order summary when the cart genuinely has items', async () => {
    h.state.conv = { ...(h.state.conv as object), ai_cart: [{ product_id: 'p1', product_name: 'Marmita G', quantity: 2, unit_price: 28 }] }
    h.generateReplyWithTools.mockResolvedValue({
      text: 'Confirmando seu pedido:\n* 2 marmitas G\n* Total: R$64\nPosso confirmar?',
      handoff: false,
      usage: null,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('R$64') }))
  })

  it('does not block an ordinary menu-price quote (no "total" wording) even with an empty cart', async () => {
    h.generateReplyWithTools.mockResolvedValue({
      text: 'As marmitas estão nesses valores:\n• P: R$20\n• M: R$25\n• G: R$28',
      handoff: false,
      usage: null,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('R$28') }))
  })

  it('blocks a false "order confirmed / sent to kitchen" claim even with no price mentioned at all — regression, 2026-08-27 (Fernanda Mendonça)', async () => {
    // The Total-based check above never even ran for this one — the
    // hallucinated reply was just "Pedido confirmado! 🎉 Já estou
    // passando para a cozinha.", no price anywhere (a pickup order whose
    // summary never showed a total). No delivery_order/print_job existed
    // afterwards; place_order was never actually called.
    h.generateReplyWithTools.mockResolvedValue({
      text: 'Pedido confirmado! 🎉 Já estou passando para a cozinha.',
      handoff: false,
      usage: null,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true, ai_cart: [] })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain('without a real order behind it')
  })

  it('does not block the real deterministic order-confirmation text on an actually placed order', async () => {
    h.generateReplyWithTools.mockResolvedValue({
      text: '',
      handoff: false,
      usage: null,
      placedOrder: {
        id: 'order-1',
        total: 42,
        deliveryFee: 0,
        currency: 'BRL',
        items: [{ product_name: 'Marmita G', quantity: 1, line_total: 42 }],
      },
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Seu pedido foi enviado para a cozinha.') }),
    )
  })

  it('does not block ordinary "confirmado" chatter unrelated to order completion', async () => {
    h.generateReplyWithTools.mockResolvedValue({
      text: 'Perfeito, endereço confirmado 😊 Agora me diga a forma de pagamento.',
      handoff: false,
      usage: null,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('endereço confirmado') }),
    )
  })

  it('hands off to a human — instead of silently dropping the thread — when the provider throws mid tool-loop', async () => {
    h.generateReplyWithTools.mockRejectedValue(
      new Error('Gemini rate limit reached: quota exceeded'),
    )
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      ai_cart: [],
    })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain('provider error')
  })
})
