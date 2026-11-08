import { describe, expect, it } from 'vitest';
import { contrastRatio, relativeLuminance } from './contrast';
import { STATE_NAMES, colors, contrastPairs, type, type ColorScheme } from './tokens';

describe('contrast helper', () => {
  it('matches the WCAG reference values', () => {
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 5);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 1);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
  });
  it('rejects non-hex input', () => {
    expect(() => contrastRatio('rgb(0,0,0)', '#FFFFFF')).toThrow();
  });
});

describe.each(['light', 'dark'] as ColorScheme[])('%s palette meets WCAG AA', (scheme) => {
  const palette = colors[scheme];
  const pairs = contrastPairs(palette);

  it('lists every state and the tint pairs', () => {
    for (const name of STATE_NAMES) expect(pairs.some((p) => p.name === `${name} fg on soft`)).toBe(true);
    expect(pairs.some((p) => p.name === 'onTint on tint')).toBe(true);
    expect(pairs.length).toBeGreaterThan(40);
  });

  it.each(pairs.map((p) => [p.name, p] as const))('%s', (_name, pair) => {
    const ratio = contrastRatio(pair.fg, pair.bg);
    expect(ratio, `${pair.fg} on ${pair.bg}`).toBeGreaterThanOrEqual(pair.min);
  });

  it('keeps the separator visible but quiet', () => {
    const r = contrastRatio(palette.separator, palette.bg);
    expect(r).toBeGreaterThan(1.15);
    expect(r).toBeLessThan(2);
  });
});

describe('type scale', () => {
  it('stays on the 11pt floor with Body at 17', () => {
    expect(type.body.fontSize).toBe(17);
    for (const t of Object.values(type)) {
      expect(t.fontSize).toBeGreaterThanOrEqual(11);
      expect(t.lineHeight).toBeGreaterThan(t.fontSize);
    }
  });
  it('tightens tracking as text gets smaller than Body, loosens above it', () => {
    expect(type.largeTitle.letterSpacing).toBeGreaterThan(0);
    expect(type.body.letterSpacing).toBeLessThan(0);
    expect(type.caption2.letterSpacing).toBeGreaterThanOrEqual(0);
    for (const t of Object.values(type)) expect(Math.abs(t.letterSpacing)).toBeLessThanOrEqual(0.04 * t.fontSize);
  });
  it('caps Dynamic Type growth tighter on titles than on body', () => {
    expect(type.largeTitle.maxFontSizeMultiplier).toBeLessThan(type.body.maxFontSizeMultiplier);
    for (const t of Object.values(type)) {
      expect(t.maxFontSizeMultiplier).toBeGreaterThanOrEqual(1.3);
      expect(t.maxFontSizeMultiplier).toBeLessThanOrEqual(2);
    }
  });
});
