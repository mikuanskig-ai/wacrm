import { describe, expect, it } from 'vitest';
import { isValidSlugFormat, slugify } from './slug';

describe('isValidSlugFormat', () => {
  it('accepts lowercase-kebab-case slugs', () => {
    expect(isValidSlugFormat('pizzaria-do-joao')).toBe(true);
    expect(isValidSlugFormat('abc')).toBe(true);
    expect(isValidSlugFormat('a1-b2-c3')).toBe(true);
  });

  it('rejects uppercase letters', () => {
    expect(isValidSlugFormat('Pizzaria')).toBe(false);
  });

  it('rejects leading, trailing, or doubled hyphens', () => {
    expect(isValidSlugFormat('-pizzaria')).toBe(false);
    expect(isValidSlugFormat('pizzaria-')).toBe(false);
    expect(isValidSlugFormat('pizza--ria')).toBe(false);
  });

  it('rejects spaces, accents, and other symbols', () => {
    expect(isValidSlugFormat('pizza ria')).toBe(false);
    expect(isValidSlugFormat('pizzaria_do_joao')).toBe(false);
    expect(isValidSlugFormat('pizzaria.do.joao')).toBe(false);
    expect(isValidSlugFormat('pizzariajoão')).toBe(false);
  });

  it('rejects too-short and too-long slugs', () => {
    expect(isValidSlugFormat('ab')).toBe(false);
    expect(isValidSlugFormat('a'.repeat(61))).toBe(false);
    expect(isValidSlugFormat('a'.repeat(60))).toBe(true);
  });
});

describe('slugify', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(slugify('Pizzaria do Joao')).toBe('pizzaria-do-joao');
  });

  it('strips accents', () => {
    expect(slugify('Pizzaria do João')).toBe('pizzaria-do-joao');
  });

  it('collapses repeated separators and trims edges', () => {
    expect(slugify('  Café -- Central!! ')).toBe('cafe-central');
  });

  it('produces a slug that itself passes isValidSlugFormat when long enough', () => {
    const result = slugify('Pizzaria do João');
    expect(isValidSlugFormat(result)).toBe(true);
  });
});
