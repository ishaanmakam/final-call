import { describe, expect, it } from 'vitest';
import { LEGAL_CONTACT, PRIVACY, TERMS, legalMarkdown } from './content';

const BANNED = /\b(bet|bets|betting|wager|stake|stakes|pot)\b/i;
const text = (d: typeof PRIVACY) => legalMarkdown(d);

/** The app has no @types/node; vitest runs on Node, so reach the file system through an untyped import. */
async function readRepoFile(relativeToApp: string): Promise<string> {
  const fs = (await import('node:' + 'fs')) as { readFileSync(path: string, enc: string): string };
  const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd(); // vitest runs from app/
  return fs.readFileSync(`${cwd}/${relativeToApp}`, 'utf8').replace(/\r\n/g, '\n');
}

describe('legal copy', () => {
  it('uses the product glossary (pledge / forfeit / pool), never betting words', () => {
    for (const d of [PRIVACY, TERMS]) {
      for (const line of text(d).split('\n')) {
        // "not gambling" and "betting operator" are allowed only in the disclaimer that denies them
        if (/not gambling|betting operator|no .*rake/i.test(line)) continue;
        expect(line, line).not.toMatch(BANNED);
      }
    }
  });

  it('says the things App Review and the data-collection label depend on', () => {
    const p = text(PRIVACY);
    expect(p).toMatch(/30 days/);
    expect(p).toMatch(/No background location/);
    expect(p).toMatch(/No real money/);
    expect(p).toMatch(/Delete account/);
    expect(p).toMatch(/17 and older/);
    expect(p).toMatch(/Supabase/);
    expect(p).toMatch(/Expo/);
    expect(p).toMatch(/Sentry/);
    expect(p).toMatch(/Venmo/);
    expect(p).toContain(LEGAL_CONTACT);
    const t = text(TERMS);
    expect(t).toMatch(/never collects, holds, transfers or charges money/);
    expect(t).toMatch(/Unverified and never costs/);
    expect(t).toMatch(/\$100/);
  });

  it('the web copies in docs/legal are exactly the in-app text', async () => {
    expect(await readRepoFile('../docs/legal/PRIVACY.md')).toBe(text(PRIVACY));
    expect(await readRepoFile('../docs/legal/TERMS.md')).toBe(text(TERMS));
  });
});
