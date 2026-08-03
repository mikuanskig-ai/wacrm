import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createCampaign, BroadcastError, pickVariant, resolveCampaignVariables } from './broadcast-core';

// These assertions all fire in the pure validation prologue, before
// any Supabase call — a bare stub is enough.
const db = {} as SupabaseClient;

describe('createCampaign validation', () => {
  it('rejects missing message_variants', async () => {
    await expect(
      createCampaign(db, 'acc', 'user', {
        messageVariants: [],
        delaySeconds: 30,
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('rejects when neither segment nor recipients is provided', async () => {
    await expect(
      createCampaign(db, 'acc', 'user', {
        messageVariants: ['Oi!'],
        delaySeconds: 30,
      })
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('rejects an empty recipient list', async () => {
    await expect(
      createCampaign(db, 'acc', 'user', {
        messageVariants: ['Oi!'],
        delaySeconds: 30,
        recipients: [],
      })
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('rejects more than 2000 recipients', async () => {
    const recipients = Array.from({ length: 2001 }, () => ({
      to: '+14155550123',
    }));
    await expect(
      createCampaign(db, 'acc', 'user', {
        messageVariants: ['Oi!'],
        delaySeconds: 30,
        recipients,
      })
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('pickVariant', () => {
  it('returns the only variant when there is just one', () => {
    expect(pickVariant(['only one'])).toBe('only one');
  });

  it('always returns one of the given variants', () => {
    const variants = ['a', 'b', 'c'];
    for (let i = 0; i < 20; i++) {
      expect(variants).toContain(pickVariant(variants));
    }
  });

  it('returns empty string for an empty list', () => {
    expect(pickVariant([])).toBe('');
  });
});

describe('resolveCampaignVariables', () => {
  const contact = { name: 'Jane', phone: '+14155550123' };

  it('resolves custom-field tokens', () => {
    expect(
      resolveCampaignVariables('Plano: {{plano}}', contact, { plano: 'Premium' })
    ).toBe('Plano: Premium');
  });

  it('falls back to built-in nome/telefone', () => {
    expect(resolveCampaignVariables('Oi {{nome}}!', contact, {})).toBe('Oi Jane!');
    expect(resolveCampaignVariables('Tel: {{telefone}}', contact, {})).toBe(
      'Tel: +14155550123'
    );
  });

  it('resolves an unknown token to empty string rather than leaving it literal', () => {
    expect(resolveCampaignVariables('X{{nonexistent}}Y', contact, {})).toBe('XY');
  });

  it('prefers a custom field over the built-in name when both are called "nome"', () => {
    expect(
      resolveCampaignVariables('{{nome}}', contact, { nome: 'Custom Name' })
    ).toBe('Custom Name');
  });
});
